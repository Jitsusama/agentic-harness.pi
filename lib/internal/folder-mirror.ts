/**
 * A folder's files and their parses, kept for synchronous readers and
 * refreshed off the thread.
 *
 * A host runs every conversation on one thread, so a synchronous read of
 * a folder on a stalled disk holds them all: on 16 November six reads of
 * the mesh's folders held the background host's loop for 8 to 17 s each.
 * A mirror answers those readers from what it last read, and reads again
 * through the promise API, once for every caller in the process.
 *
 * It spends only while asked. The first ask in a process reads the folder
 * at once, since an empty answer before the mirror fills would read as
 * nobody there. After that, a poll reads it again each second while a
 * synchronous reader has asked within the last minute, and stops once
 * none has. fs.watch brings a refresh forward, but only as a hint, since
 * some filesystems miss renames: the poll stands on its own. A refresh
 * already reading is joined, never run beside itself. What the process
 * writes itself is put in at once.
 */

import { type FSWatcher, readdirSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readStamped, readStampedOff, type Stamped } from "./stamped-read.ts";

/** How often a mirror reads its folder again while it is asked. */
const POLL_MS = 1000;

/** How long a mirror keeps polling after its last synchronous ask. */
const IDLE_MS = 60_000;

/** The files a mirror keeps, and how it parses one. */
export interface MirroredFiles<T> {
	/** The ending of a file the mirror keeps, such as `.json`. */
	readonly suffix: string;
	/** The file at a path, parsed on the thread; none when unreadable. */
	read(path: string): T | undefined;
	/** The file at a path, parsed off the thread; none when unreadable. */
	readOff(path: string): Promise<T | undefined>;
}

/** How long a mirror waits, for a test that can't wait a minute. */
export interface MirrorTimes {
	readonly pollMs?: number;
	readonly idleMs?: number;
}

/** A folder's files as last read, by path, in the folder's own order. */
export type Mirrored<T> = ReadonlyMap<string, T | undefined>;

/** One folder's files, mirrored or read as asked. */
export interface FolderMirror<T> {
	/** Its files as last read, for a synchronous reader. */
	files(): Mirrored<T>;
	/** One of its files, as `files()` has it. */
	file(path: string): T | undefined;
	/** Its files read again off the thread, joining a read in flight. */
	refresh(): Promise<Mirrored<T>>;
	/** A file this process wrote, as it parses. */
	put(path: string, value: T | undefined): void;
	/** A file this process removed. */
	drop(path: string): void;
}

/**
 * One mirror a folder for files of one kind, made on first ask and kept
 * for the life of the module: a mirror nobody asks stops its poll and
 * its watch, so what it keeps is one listing of small files.
 */
export function folderMirrors<T>(
	kind: MirroredFiles<T>,
	times: MirrorTimes = {},
): (dir: string) => FolderMirror<T> {
	const mirrors = new Map<string, FolderMirror<T>>();
	return (dir) => {
		let mirror = mirrors.get(dir);
		if (mirror === undefined) {
			mirror = mirrorOf(dir, kind, times);
			mirrors.set(dir, mirror);
		}
		return mirror;
	};
}

/**
 * A folder read as it is asked, each file's parse kept while its stamp
 * holds: for a process with one conversation, whose stalled read holds
 * only itself, and which then spends nothing while nobody asks.
 */
export function folderRead<T>(
	dir: string,
	kind: MirroredFiles<T>,
): FolderMirror<T> {
	const kept = new Map<string, Stamped<T>>();
	const listed = (names: string[], values: (T | undefined)[]): Mirrored<T> => {
		const paths = pathsIn(dir, kind, names);
		const found = new Set(paths);
		for (const path of kept.keys()) if (!found.has(path)) kept.delete(path);
		return new Map(paths.map((path, at) => [path, values[at]]));
	};
	return {
		files() {
			let names: string[] = [];
			try {
				names = readdirSync(dir);
			} catch {
				// No folder yet: nothing written there.
			}
			const paths = pathsIn(dir, kind, names);
			return listed(
				names,
				paths.map((path) => readStamped(kept, path, kind.read)),
			);
		},
		file: (path) => readStamped(kept, path, kind.read),
		async refresh() {
			// No folder yet: nothing written there.
			const names = await readdir(dir).catch((): string[] => []);
			const paths = pathsIn(dir, kind, names);
			const values = await Promise.all(
				paths.map((path) => readStampedOff(kept, path, kind.readOff)),
			);
			return listed(names, values);
		},
		// The disk is read at each ask, so a write is seen there.
		put: nothing,
		drop: (path) => {
			kept.delete(path);
		},
	};
}

/** The paths of the files of `kind` among a folder's `names`. */
function pathsIn<T>(
	dir: string,
	kind: MirroredFiles<T>,
	names: string[],
): string[] {
	return names
		.filter((name) => name.endsWith(kind.suffix))
		.map((name) => join(dir, name));
}

function mirrorOf<T>(
	dir: string,
	kind: MirroredFiles<T>,
	times: MirrorTimes,
): FolderMirror<T> {
	const pollMs = times.pollMs ?? POLL_MS;
	const idleMs = times.idleMs ?? IDLE_MS;
	const kept = new Map<string, Stamped<T>>();
	let order: string[] | undefined;
	let asked = 0;
	let clock: ReturnType<typeof setInterval> | undefined;
	let watcher: FSWatcher | undefined;
	let flight: Promise<Mirrored<T>> | undefined;
	// A write counts up, so a read that began before it keeps what it put
	// or removed, rather than landing what the file was before.
	let writes = 0;
	const written = new Map<
		string,
		{ at: number; value: T | undefined; gone: boolean }
	>();

	const view = (): Mirrored<T> =>
		new Map((order ?? []).map((path) => [path, kept.get(path)?.value]));
	const settle = (paths: string[], since: number): void => {
		const listed = new Set(paths);
		for (const [path, { at, value, gone }] of written) {
			if (at <= since) written.delete(path);
			else if (gone) listed.delete(path);
			else {
				kept.set(path, { stamp: "", value });
				listed.add(path);
			}
		}
		for (const path of kept.keys()) if (!listed.has(path)) kept.delete(path);
		order = [...listed];
	};
	const fill = (): void => {
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			// No folder yet: nothing written there.
		}
		const paths = pathsIn(dir, kind, names);
		for (const path of paths) readStamped(kept, path, kind.read);
		settle(paths, writes);
	};
	const readAgain = async (): Promise<Mirrored<T>> => {
		const since = writes;
		// No folder yet: nothing written there.
		const names = await readdir(dir).catch((): string[] => []);
		const paths = pathsIn(dir, kind, names);
		await Promise.all(
			paths.map((path) => readStampedOff(kept, path, kind.readOff)),
		);
		settle(paths, since);
		return view();
	};
	const refresh = (): Promise<Mirrored<T>> => {
		flight ??= readAgain().finally(() => {
			flight = undefined;
		});
		return flight;
	};
	const unwatch = (): void => {
		watcher?.close();
		watcher = undefined;
	};
	const rewatch = (): void => {
		if (watcher !== undefined) return;
		try {
			watcher = watch(dir, { persistent: false }, () => {
				void refresh().catch(nothing);
			});
			// A watch that fails or overflows leaves the poll to keep up.
			watcher.on("error", unwatch);
		} catch {
			// No folder yet, or no watch on this filesystem: the poll alone.
		}
	};
	const tick = (): void => {
		if (Date.now() - asked > idleMs) {
			clearInterval(clock);
			clock = undefined;
			unwatch();
			return;
		}
		rewatch();
		void refresh().catch(nothing);
	};
	const files = (): Mirrored<T> => {
		asked = Date.now();
		// The first ask reads at once; after an idle spell, the last listing
		// answers while a fresh one is read.
		if (order === undefined) fill();
		else if (clock === undefined) void refresh().catch(nothing);
		if (clock === undefined) {
			clock = setInterval(tick, pollMs);
			clock.unref();
			rewatch();
		}
		return view();
	};
	return {
		files,
		file: (path) => files().get(path),
		refresh,
		put(path, value) {
			writes += 1;
			written.set(path, { at: writes, value, gone: false });
			kept.set(path, { stamp: "", value });
			if (order !== undefined && !order.includes(path))
				order = [...order, path];
		},
		drop(path) {
			writes += 1;
			written.set(path, { at: writes, value: undefined, gone: true });
			kept.delete(path);
			if (order !== undefined) order = order.filter((one) => one !== path);
		},
	};
}

/** Nothing, for a refresh whose failure the next tick reads past. */
function nothing(): void {
	// A folder that can't be read now is read again on the next tick.
}
