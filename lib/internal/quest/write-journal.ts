/**
 * The account's journal of quest writes: one line a write, naming the
 * quest folder it landed in, appended by every process that writes a
 * quest and read by every host's discovery, so a process learns which
 * quests another changed without walking the whole tree to find out.
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
 * and discovery walks as before. A write noted only after its file is
 * whole, so a reader that reads the line reads the write.
 */

import {
	closeSync,
	fstatSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/** The journal's name in the quest lock folder. */
const JOURNAL_NAME = "writes.log";

/**
 * How large the journal may grow before a writer starts it afresh,
 * about seven thousand writes. A reader that finds it started afresh
 * signs its tree whole once, since it can't tell what it missed.
 */
const JOURNAL_MOST_BYTES = 1024 * 1024;

/** Where a journal read stood: the file, and how far into it. */
export interface JournalMark {
	/** The file's inode, which a fresh start changes. */
	readonly ino: number;
	/** The bytes read so far, each ending a whole line. */
	readonly at: number;
}

/** The journal's file in the quest lock folder `folder`. */
export function journalIn(folder: string): string {
	return join(folder, JOURNAL_NAME);
}

/**
 * Note that a write landed in the quest folder `questDir`, in the
 * journal at `file`. Never throws: a write the journal can't hear is
 * read by the next whole signing, as every write was before it.
 */
export function noteQuestWrite(file: string, questDir: string): void {
	try {
		startAfreshIfFull(file);
		const fd = openSync(file, "a", 0o600);
		try {
			// One write of one short line, which O_APPEND keeps whole.
			writeSync(fd, `${questDir}\n`);
		} finally {
			closeSync(fd);
		}
	} catch {
		// No journal this time: readers sign whole by their backstop.
	}
}

/** Move a full journal aside, so the next line starts a fresh one. */
function startAfreshIfFull(file: string): void {
	let size: number;
	try {
		size = statSync(file).size;
	} catch {
		// None yet: the append makes it.
		return;
	}
	if (size < JOURNAL_MOST_BYTES) return;
	try {
		renameSync(file, `${file}.old`);
	} catch {
		// Another writer moved it first, which is the same fresh start.
	}
}

/**
 * Where the journal at `file` stands now, to read on from: its start,
 * under no inode, when no write has made it yet.
 */
export function journalNow(file: string): JournalMark {
	try {
		const stat = statSync(file);
		return { ino: stat.ino, at: stat.size };
	} catch {
		// Made by the first write after this; until then nothing is noted.
		return { ino: 0, at: 0 };
	}
}

/**
 * The quest folders noted in the journal at `file` since `mark`, and
 * the mark to read on from. "started afresh" when the journal is
 * another file than the mark's, or shorter, so what came between can't
 * be known. A line still being written is left for the next read.
 */
export function journalSince(
	file: string,
	mark: JournalMark,
):
	| { readonly dirs: readonly string[]; readonly mark: JournalMark }
	| "started afresh" {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		// Never made: nothing noted, unless one was there at the mark.
		return mark.ino === 0 ? { dirs: [], mark } : "started afresh";
	}
	try {
		const { ino, size } = fstatSync(fd);
		// Made since a mark taken before it was: every line in it is new.
		const made = mark.ino === 0;
		if (!made && (ino !== mark.ino || size < mark.at)) return "started afresh";
		const from = made ? 0 : mark.at;
		if (size === from) return { dirs: [], mark: { ino, at: from } };
		const bytes = Buffer.alloc(size - from);
		const got = readSync(fd, bytes, 0, bytes.length, from);
		const text = bytes.subarray(0, got).toString("utf8");
		const end = text.lastIndexOf("\n");
		if (end < 0) return { dirs: [], mark: { ino, at: from } };
		const whole = text.slice(0, end);
		const dirs = whole.split("\n").filter((line) => line.length > 0);
		const read = Buffer.byteLength(whole, "utf8") + 1;
		return { dirs, mark: { ino, at: from + read } };
	} catch {
		// Unreadable now: read as a fresh start, which a whole signing settles.
		return "started afresh";
	} finally {
		closeSync(fd);
	}
}
