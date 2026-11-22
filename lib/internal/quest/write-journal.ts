/**
 * The account's journal of quest writes: one line a write, naming the
 * quest folder it landed in, appended by every process on code that
 * knows it and read by every host's discovery, so a process learns
 * which quests another changed without walking the whole tree to find
 * out.
 *
 * On 21 November about eighty processes, one a conversation, each
 * walked the same 1,543 quests every few seconds to see each other's
 * writes, and their listings queued on the same btrfs locks: thirteen
 * walks in half an hour ran past 30 s, the longest 85 s. A line here
 * costs one append on tmpfs, and reading what is new costs a stat and
 * a read of the lines since.
 *
 * The journal sits in the quest lock folder, on the login's runtime
 * folder, which every writer on the machine already finds, the fence
 * included. Where there is none, as on the Mac, there is no journal
 * and discovery walks as before. A write is noted only after its file
 * is whole, so a reader that reads the line reads the write.
 *
 * Fenced commands can write that folder, so the journal is never taken
 * on trust: it is opened without following a link and without waiting
 * on a pipe, and anything there but a plain file is moved aside, which
 * every reader reads as a fresh start and settles with a whole signing.
 * The worst a planted file can do is send hosts back to walking.
 */

import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/** The journal's mode: its owner's alone, to read and write. */
const JOURNAL_MODE = 0o600;

/** The permission bits of a file's mode, which `JOURNAL_MODE` sets. */
const JOURNAL_MODE_BITS = 0o777;

/** The journal's name in the quest lock folder. */
const JOURNAL_NAME = "writes.log";

/** Where a full journal is moved, so a reader can read on through it. */
const MOVED_ASIDE = ".old";

/**
 * How large the journal may grow before a writer moves it aside, about
 * seven thousand writes. A reader whose mark is in the moved file reads
 * on through it, so a move costs no reader a whole signing.
 */
const JOURNAL_MOST_BYTES = 1024 * 1024;

/**
 * The most a read since a mark takes in. Past this the file is not one
 * the writers keep, which rotate at `JOURNAL_MOST_BYTES`, so the reader
 * starts afresh rather than reading it.
 */
const READ_MOST_BYTES = 2 * JOURNAL_MOST_BYTES;

/** Opened as a journal is: never through a link, never waiting on a pipe. */
const UNTRUSTED = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A newline, as the journal's bytes hold it. */
const NEWLINE = 0x0a;

/** Where a journal read stood: the file, and how far into it. */
export interface JournalMark {
	/** The file's inode, which a fresh start changes. */
	readonly ino: number;
	/**
	 * The bytes read so far. A writer's one short append lands whole, so
	 * this ends a line; one that doesn't is read from the next newline.
	 */
	readonly at: number;
}

/** What a read since a mark found, or that what came between is lost. */
export type JournalRead =
	| { readonly dirs: readonly string[]; readonly mark: JournalMark }
	| "started afresh";

/** The journal's file in the quest lock folder `folder`. */
export function journalIn(folder: string): string {
	return join(folder, JOURNAL_NAME);
}

/**
 * Note that a write landed in the quest folder `questDir`, in the
 * journal at `file`. Never throws: a write the journal can't hear is
 * read by the next whole signing, as every write was before it. A
 * journal it can't append to is moved aside, so readers start afresh
 * rather than trust a file that has stopped hearing writes, and the
 * line goes into a fresh one.
 */
export function noteQuestWrite(file: string, questDir: string): void {
	const line = Buffer.from(`${questDir}\n`, "utf8");
	if (appended(file, line) === "moved aside") appended(file, line);
}

/**
 * Append `line` to the journal at `file`: "moved aside" when it couldn't
 * and the journal was moved aside for it, which never throws.
 */
function appended(file: string, line: Buffer): "appended" | "moved aside" {
	try {
		const fd = openToAppend(file);
		try {
			// One write of one short line, which O_APPEND keeps whole.
			if (writeSync(fd, line) === line.length) return "appended";
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		// A folder that isn't there has no readers to tell.
		if (isMissing(error)) return "appended";
	}
	// The journal stopped hearing writes, so its readers must know.
	moveAside(file);
	return "moved aside";
}

/** Open `file` as a plain file, refusing a link, a pipe or a device. */
function openPlain(file: string, flags: number): number {
	const fd = openSync(file, flags | UNTRUSTED, JOURNAL_MODE);
	if (fstatSync(fd).isFile()) return fd;
	closeSync(fd);
	throw new Error(`${file} is not a plain file`);
}

/**
 * Open the journal at `file` to append to, making it if none is there.
 * A full one is moved aside first, so the line starts a fresh one. Its
 * size is read from the file opened, which costs no look by its name.
 */
function openToAppend(file: string): number {
	const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
	const fd = openPlain(file, flags);
	if (fstatSync(fd).size < JOURNAL_MOST_BYTES && keptToOwner(fd)) return fd;
	closeSync(fd);
	moveAside(file);
	return openPlain(file, flags);
}

/**
 * Whether the journal open at `fd` is its owner's to read and write
 * alone, set so when it isn't: a journal its readers can't open has
 * stopped being heard as surely as a full one, and is moved aside
 * like one when its mode can't be set back.
 */
function keptToOwner(fd: number): boolean {
	if ((fstatSync(fd).mode & JOURNAL_MODE_BITS) === JOURNAL_MODE) return true;
	try {
		fchmodSync(fd, JOURNAL_MODE);
		return true;
	} catch {
		// Not this user's file: moved aside instead, for a fresh one.
		return false;
	}
}

/**
 * Move the journal aside, whatever stands at its name. What stands at
 * the moved name and blocks the move, as an empty folder planted there
 * would, is removed and the move tried again; what still won't move is
 * removed, so the next write makes a fresh journal rather than leave
 * one that has stopped hearing writes. Nothing is removed whole, as
 * io.ts's `clearAside` removes nothing whole in this folder, since a
 * fenced command can plant a tree here, and a walk through one can be
 * led outside it. What can't be cleared is said once, and its readers
 * go without a journal (`journalNow`). Never throws.
 */
function moveAside(file: string): void {
	const aside = `${file}${MOVED_ASIDE}`;
	if (renamed(file, aside)) return;
	clearOne(aside);
	if (renamed(file, aside)) return;
	const error = clearOne(file);
	if (error !== undefined) sayStuck(file, error);
}

/**
 * Remove what stands at `path`, a file, a link or an empty folder, and
 * never a folder's contents: undefined once nothing stands there, or
 * the error that kept it.
 */
function clearOne(path: string): unknown {
	try {
		if (lstatSync(path).isDirectory()) rmdirSync(path);
		else unlinkSync(path);
		return undefined;
	} catch (error) {
		return isMissing(error) ? undefined : error;
	}
}

/** Whether `from` moved to `to`, or was already gone. */
function renamed(from: string, to: string): boolean {
	try {
		renameSync(from, to);
		return true;
	} catch (error) {
		// Another writer moved it first, which is the same fresh start.
		return isMissing(error);
	}
}

/** Whether a stuck journal was said yet, so it is said once a process. */
let saidStuck = false;

/** Say once that the journal at `file` could be neither moved nor removed. */
function sayStuck(file: string, error: unknown): void {
	if (saidStuck) return;
	saidStuck = true;
	const why = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		`quest journal ${file} stopped hearing writes and could be neither moved aside nor removed (${why}); hosts sign whole walks until it is.\n`,
	);
}

/** Whether `error` says a path isn't there. */
function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Where the journal at `file` stands now, to read on from: its start,
 * under no inode, when no write has made it yet. Undefined when what
 * stands there can't be read as a journal (a link, a folder, a pipe, a
 * file this user can't read), so its reader goes without one, signing
 * at the usual pace, rather than start afresh at every ask.
 */
export function journalNow(file: string): JournalMark | undefined {
	let fd: number;
	try {
		fd = openPlain(file, constants.O_RDONLY);
	} catch (error) {
		// Made by the first write after this; until then nothing is noted.
		return isMissing(error) ? { ino: 0, at: 0 } : undefined;
	}
	try {
		const { ino, size } = fstatSync(fd);
		return { ino, at: size };
	} finally {
		closeSync(fd);
	}
}

/**
 * The quest folders noted in the journal at `file` since `mark`, and
 * the mark to read on from. A journal moved aside since the mark is
 * read on through, then the fresh one from its start. "started afresh"
 * when what came between can't be known: the file is another than the
 * mark's and not the one moved aside, it shrank, it isn't a plain file,
 * or it holds more than any writer would. A line still being written
 * is left for the next read.
 */
export function journalSince(file: string, mark: JournalMark): JournalRead {
	// A file other than the mark's is read from its start.
	const now = linesIn(file, mark, 0);
	if (now === "started afresh") return now;
	const same = now !== "none" && now.mark.ino === mark.ino;
	// Never made since a mark taken before it was, or read on as it was.
	if (mark.ino === 0 || same) {
		return now === "none" ? { dirs: [], mark } : now;
	}
	// Moved aside since the mark: what the mark's file gained, then the
	// fresh one, if one is made yet.
	const moved = linesIn(`${file}${MOVED_ASIDE}`, mark, undefined);
	if (moved === "started afresh" || moved === "none") return "started afresh";
	if (now === "none") return { dirs: moved.dirs, mark: { ino: 0, at: 0 } };
	return { dirs: [...moved.dirs, ...now.dirs], mark: now.mark };
}

/**
 * The whole lines in the journal at `file` past `mark` when it is the
 * mark's file, or from `start` when it is another and `start` is given,
 * with the mark to read on from; "none" when it isn't there.
 */
function linesIn(
	file: string,
	mark: JournalMark,
	start: number | undefined,
): Exclude<JournalRead, "started afresh"> | "none" | "started afresh" {
	let fd: number;
	try {
		fd = openPlain(file, constants.O_RDONLY);
	} catch (error) {
		return isMissing(error) ? "none" : "started afresh";
	}
	try {
		const { ino, size } = fstatSync(fd);
		const ours = mark.ino !== 0 && ino === mark.ino;
		const from = ours ? mark.at : start;
		if (from === undefined || size < from) return "started afresh";
		if (size - from > READ_MOST_BYTES) return "started afresh";
		const bytes = Buffer.alloc(size - from);
		const got = readSync(fd, bytes, 0, bytes.length, from);
		const end = bytes.subarray(0, got).lastIndexOf(NEWLINE);
		const whole = end < 0 ? "" : bytes.subarray(0, end).toString("utf8");
		const dirs = whole.split("\n").filter((line) => line.length > 0);
		const at = end < 0 ? from : from + end + 1;
		return { dirs, mark: { ino, at } };
	} catch {
		// Unreadable now: read as a fresh start, which a whole signing settles.
		return "started afresh";
	} finally {
		closeSync(fd);
	}
}
