/**
 * Writing a file whole, so a reader never sees half of it, without
 * waking whoever watches its folder more than once.
 *
 * The file is written in a `.writing` subfolder beside it and renamed
 * into place. The rename stays atomic, since both are on one
 * filesystem, and a watcher of the folder (the shell watches the
 * mesh's presence, the machine queue's folder and the quest folders
 * with something waiting on Joel) hears one event a write instead of
 * the three or four a temp file made, written and renamed beside it
 * gives: inotify watches don't reach into subfolders.
 *
 * A writer that shares its thread (a host runs every conversation on
 * one) writes off it, in the order it asked, through `wholeWrites`.
 *
 * A durable write on the thread skips its flush where the rename alone
 * keeps it whole: replacing a file that isn't empty on btrfs. There
 * `btrfs_rename` starts the new file's writeback as it renames over a
 * regular file with content (fs/btrfs/inode.c, "we're using rename to
 * replace one file with another"), so the commit that lands the rename
 * lands the data too. The flush held a host's thread about 13 s in its
 * hold samples of 16 and 17 November. Its cost: a power cut within
 * btrfs's commit interval, 30 s by default, can keep the edit before.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import {
	mkdir as mkdirOff,
	open as openOff,
	rename as renameOff,
	rm as rmOff,
	writeFile as writeFileOff,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { processGlobal } from "./process/process-global.ts";

/** The subfolder a file is written in before it is renamed into place. */
export const WRITING = ".writing";

/** How a file is written whole. */
export interface WriteWholeOptions {
	/**
	 * Flush the content to the disk before it is renamed into place, so
	 * a power cut leaves the old file or the new one, never an empty one.
	 * Records a person keeps (a quest's README) ask for it; state that is
	 * written again within seconds does not. Where the rename keeps that
	 * already, the flush is left out (see the header).
	 */
	readonly durable?: boolean;
	/** The file's mode, for one only its owner may read. */
	readonly mode?: number;
}

/** Where `file` is written before it is renamed into place. */
function stagedFor(file: string): { writing: string; staged: string } {
	const writing = join(dirname(file), WRITING);
	const staged = join(
		writing,
		`${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}`,
	);
	return { writing, staged };
}

/** Replace `file` whole with `content`, through its folder's `.writing`. */
export function writeWhole(
	file: string,
	content: string | Uint8Array,
	options: WriteWholeOptions = {},
): void {
	const { writing, staged } = stagedFor(file);
	mkdirSync(writing, { recursive: true });
	try {
		if (options.durable && !renameKeepsWhole(file))
			writeDurably(staged, content, options.mode);
		else writeFileSync(staged, content, { mode: options.mode });
		renameSync(staged, file);
	} catch (error) {
		try {
			rmSync(staged, { force: true });
		} catch {
			// The write's own error is the one to say; a staged file left is
			// cleared by clearWriting.
		}
		throw error;
	}
}

/** Replace `file` whole with `content` as `writeWhole` does, off the thread. */
export async function writeWholeOff(
	file: string,
	content: string | Uint8Array,
	options: WriteWholeOptions = {},
): Promise<void> {
	const { writing, staged } = stagedFor(file);
	await mkdirOff(writing, { recursive: true });
	try {
		if (options.durable) await writeDurablyOff(staged, content, options.mode);
		else await writeFileOff(staged, content, { mode: options.mode });
		await renameOff(staged, file);
	} catch (error) {
		try {
			await rmOff(staged, { force: true });
		} catch {
			// The write's own error is the one to say; a staged file left is
			// cleared by clearWriting.
		}
		throw error;
	}
}

async function writeDurablyOff(
	path: string,
	content: string | Uint8Array,
	mode: number | undefined,
): Promise<void> {
	const handle = await openOff(path, "w", mode);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** What a file is asked to become: its whole content, or `null` for gone. */
export type Wanted = string | null;

/**
 * A writer's files, each written whole off the thread in the order
 * asked: a file's next write starts only once the one before it landed,
 * and asks made while one is out are written as the latest of them.
 * The order is the process's, whichever writer asks, so a runtime a
 * reload replaced can't land its write after its successor's.
 */
export interface WholeWrites {
	/** Have `file` become `wanted`, off the thread, after every earlier ask. */
	ask(file: string, wanted: Wanted): void;
	/**
	 * Have `file` become `wanted` now, on the thread, as a writer that is
	 * ending must; a write still out is written over once it lands, and
	 * one that throws is written again off the thread.
	 */
	now(file: string, wanted: Wanted): void;
	/** What `file` is asked to become and isn't yet on disk; none when nothing waits. */
	waiting(file: string): Wanted | undefined;
	/** Every file waiting in `dir`, by path, in the order first asked. */
	waitingIn(dir: string): ReadonlyMap<string, Wanted>;
	/** Write every file still waiting, now, on the thread. */
	settle(): void;
}

/** How a writer's files are written off the thread. */
export interface WholeWritesOptions {
	/**
	 * Told once when a file's write fails, until one of its writes lands;
	 * it is written again meanwhile, so nothing asked is dropped.
	 */
	readonly failed?: (file: string, error: unknown) => void;
	/** How long to wait before writing a failed file again, doubling up to `most`. */
	readonly retry?: { readonly first: number; readonly most: number };
	/**
	 * Whether to write off the thread, asked at each write: a writer alone
	 * on its thread writes on the asker's turn, so a failure throws there.
	 */
	readonly offThread?: () => boolean;
	/** The write itself; a test says otherwise. */
	readonly write?: (file: string, wanted: Wanted) => Promise<void>;
}

/** The session log's entry for a write off the thread that couldn't land. */
export const WRITE_FAILED_ENTRY = "write-failed";

/**
 * How to say a write off the thread that couldn't land: an entry in the
 * session's log, through `append`, and a line on standard error, which
 * is a host's journal, so someone reads it. Only a host writes off its
 * thread, so a plain pi's window never shows the line.
 */
export function sayWriteFailed(
	append: (type: string, data: unknown) => void,
): (file: string, error: unknown) => void {
	return (file, error) => {
		const said = error instanceof Error ? error.message : String(error);
		append(WRITE_FAILED_ENTRY, { file, error: said });
		process.stderr.write(
			`couldn't write ${file} off the thread, so it is written again: ${said}\n`,
		);
	};
}

/** How long a failed write waits before it is tried again, at first and at most. */
const RETRY_FIRST_MS = 5000;
const RETRY_MOST_MS = 60_000;

/**
 * One file's writes: what is wanted, how many asks, which last landed,
 * and how the writer that asked last has it written and said.
 */
interface FileWrites {
	wanted: Wanted;
	/** Asks made, counting up; `landed` reaching it means nothing waits. */
	asked: number;
	/** The ask whose content last landed, by its count. */
	landed: number;
	out: boolean;
	failing: boolean;
	delay: number;
	retry?: ReturnType<typeof setTimeout>;
	first: number;
	most: number;
	write: (file: string, wanted: Wanted) => Promise<void>;
	failed?: (file: string, error: unknown) => void;
}

// Every file's writes, for the whole process and every copy of this
// module: a reload loads a fresh copy, and its runtime writes the same
// session's files while the one it replaced may have a write out. The
// key names the shape; a change to FileWrites takes a new one.
const files = processGlobal(
	"agentic-harness.internal/write-whole/files.v1",
	() => new Map<string, FileWrites>(),
);

const waits = (one: FileWrites) => one.landed !== one.asked;

/** A file with nothing waiting, out or to try again is let go. */
function letGo(file: string, one: FileWrites): void {
	if (!waits(one) && !one.out && one.retry === undefined) files.delete(file);
}

/** Say a file's write failed, once until one of its writes lands. */
function sayFailed(file: string, one: FileWrites, error: unknown): void {
	if (one.failing) return;
	one.failing = true;
	try {
		one.failed?.(file, error);
	} catch {
		// Saying it failed is best effort; the write is tried again anyway.
	}
}

/** Write a failed file again after its spell, which doubles to its most. */
function later(file: string, one: FileWrites): void {
	if (one.out || one.retry !== undefined) return;
	one.retry = setTimeout(() => {
		one.retry = undefined;
		void drain(file, one);
	}, one.delay);
	one.retry.unref?.();
	one.delay = Math.min(one.delay * 2, one.most);
}

/** Write a file's latest ask off the thread until nothing waits. */
async function drain(file: string, one: FileWrites): Promise<void> {
	if (one.out) return;
	one.out = true;
	let failure: { error: unknown } | undefined;
	try {
		while (waits(one)) {
			const asked = one.asked;
			await one.write(file, one.wanted);
			// What landed is this ask's: a write made on the thread since is
			// written over, so it is written again as the latest.
			one.landed = asked;
			one.failing = false;
			one.delay = one.first;
		}
	} catch (error) {
		failure = { error };
	} finally {
		one.out = false;
	}
	// A write that failed after the thread landed its file fails nothing.
	if (failure && waits(one)) {
		sayFailed(file, one, failure.error);
		later(file, one);
	}
	letGo(file, one);
}

/** Write a file's latest ask on the thread, written again later if it throws. */
function onThread(file: string, one: FileWrites): void {
	try {
		writeOn(file, one.wanted);
	} catch (error) {
		later(file, one);
		throw error;
	}
	one.landed = one.asked;
	one.failing = false;
	one.delay = one.first;
	clearTimeout(one.retry);
	one.retry = undefined;
	letGo(file, one);
}

/** A writer's files, written whole off the thread in the order asked. */
export function wholeWrites(options: WholeWritesOptions = {}): WholeWrites {
	const first = options.retry?.first ?? RETRY_FIRST_MS;
	const most = options.retry?.most ?? RETRY_MOST_MS;
	const write = options.write ?? writeOff;
	// What this writer asked, so it settles only its own.
	const mine = new Set<string>();
	const asking = (file: string, wanted: Wanted): FileWrites => {
		const one = files.get(file) ?? {
			wanted,
			asked: 0,
			landed: 0,
			out: false,
			failing: false,
			delay: first,
			first,
			most,
			write,
		};
		one.wanted = wanted;
		one.asked += 1;
		// The writer that asked last writes it, and is told if it fails.
		Object.assign(one, { first, most, write, failed: options.failed });
		files.set(file, one);
		mine.add(file);
		return one;
	};
	return {
		ask(file, wanted) {
			const one = asking(file, wanted);
			if (options.offThread?.() === false) onThread(file, one);
			// A failed file waits for its retry, which writes the latest.
			else if (one.retry === undefined) void drain(file, one);
		},
		now(file, wanted) {
			onThread(file, asking(file, wanted));
		},
		waiting(file) {
			const one = files.get(file);
			return one && waits(one) ? one.wanted : undefined;
		},
		waitingIn(dir) {
			const waiting = new Map<string, Wanted>();
			for (const [file, one] of files) {
				if (waits(one) && dirname(file) === dir) waiting.set(file, one.wanted);
			}
			return waiting;
		},
		settle() {
			for (const file of [...mine]) {
				const one = files.get(file);
				if (!one) mine.delete(file);
				if (!one || !waits(one)) continue;
				try {
					onThread(file, one);
				} catch (error) {
					// Every other file still settles; this one is said, and
					// written again off the thread.
					sayFailed(file, one, error);
				}
			}
		},
	};
}

/**
 * A file as its writer asked it to be, while that hasn't landed: what
 * a read of the disk would hold as it was. None when nothing waits;
 * `gone` when it is to be taken away.
 */
export function asWaiting<T>(
	writes: WholeWrites,
	file: string,
	parse: (text: string) => T | undefined,
): { readonly value: T | undefined } | undefined {
	const wanted = writes.waiting(file);
	if (wanted === undefined) return undefined;
	return { value: wanted === null ? undefined : parseQuietly(wanted, parse) };
}

/**
 * A folder's files as read, by path, with what its writer asked and
 * hasn't landed over them; a file to be taken away reads as absent.
 */
export function overWaiting<T>(
	writes: WholeWrites,
	dir: string,
	listed: ReadonlyMap<string, T | undefined>,
	parse: (text: string) => T | undefined,
): ReadonlyMap<string, T | undefined> {
	const waiting = writes.waitingIn(dir);
	if (waiting.size === 0) return listed;
	const over = new Map(listed);
	for (const [file, wanted] of waiting) {
		if (wanted === null) over.delete(file);
		else over.set(file, parseQuietly(wanted, parse));
	}
	return over;
}

function parseQuietly<T>(
	text: string,
	parse: (text: string) => T | undefined,
): T | undefined {
	try {
		return parse(text);
	} catch {
		// What its own writer asked reads as a disk read of it would: nothing.
		return undefined;
	}
}

/** A file made `wanted` whole off the thread, or taken away. */
async function writeOff(file: string, wanted: Wanted): Promise<void> {
	if (wanted === null) await rmOff(file, { force: true });
	else await writeWholeOff(file, wanted);
}

/** A file made `wanted` whole on the thread, or taken away. */
function writeOn(file: string, wanted: Wanted): void {
	if (wanted === null) rmSync(file, { force: true });
	else writeWhole(file, wanted);
}

/** statfs's magic number for btrfs. */
const BTRFS_MAGIC = 0x9123683e;

// Whether each device's filesystem is btrfs, for the process and every
// copy of this module: a filesystem never changes under a mounted
// device, so it is asked once a device, never a path.
const btrfsDevices = processGlobal(
	"agentic-harness.internal/write-whole/btrfs-devices.v1",
	() => new Map<number, boolean>(),
);

/**
 * Whether renaming over `file` alone keeps the old content or the new
 * across a power cut: a regular file with content, by lstat, on btrfs.
 * Anything it can't tell keeps the flush.
 */
function renameKeepsWhole(file: string): boolean {
	try {
		const target = lstatSync(file, { throwIfNoEntry: false });
		if (!target?.isFile() || target.size === 0) return false;
		const known = btrfsDevices.get(target.dev);
		if (known !== undefined) return known;
		const btrfs = statfsSync(dirname(file)).type === BTRFS_MAGIC;
		btrfsDevices.set(target.dev, btrfs);
		return btrfs;
	} catch {
		// Not told, so not remembered: the flush stays, and the next write
		// asks again.
		return false;
	}
}

function writeDurably(
	path: string,
	content: string | Uint8Array,
	mode: number | undefined,
): void {
	const fd = openSync(path, "w", mode);
	try {
		if (typeof content === "string") writeSync(fd, content);
		else writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Take away what a writer left in `dir`'s `.writing` and last touched
 * before this time: one that died between writing and renaming leaves
 * a file there, and nothing else ever would.
 */
export function clearWriting(dir: string, before: number): void {
	const writing = join(dir, WRITING);
	let names: string[] = [];
	try {
		names = readdirSync(writing);
	} catch {
		return;
	}
	for (const name of names) {
		const staged = join(writing, name);
		try {
			if (statSync(staged).mtimeMs < before) rmSync(staged, { force: true });
		} catch {
			// Renamed into place, or taken by another sweep, as it was looked at.
		}
	}
}
