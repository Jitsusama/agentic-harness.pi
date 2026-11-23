/**
 * Mark the history a branch left on disk against one recall, reading
 * each log a line at a time.
 *
 * Reading the logs whole held every entry of every parent at once, and
 * a parent can be hundreds of megabytes: one search could more than
 * double a conversation's heap. A search needs only what each entry
 * holds of the query, and the text of the few the answer shows, so this
 * parses one line, marks it and lets it go.
 *
 * Which entries are on a log's branch is known only once the whole log
 * is read, since an entry names its parent and not its children. So
 * every entry of a log is marked, with its id and parent, and the branch
 * is walked from the record's leaf afterwards; the marks off it are
 * dropped. A marked entry is small unless it holds a query word, and
 * then it keeps a snippet, not its text.
 *
 * A tool call is read with its result, as in memory. The result is
 * sought in the same log only: a log rolls over between turns, so a
 * call and its result are never split across two. A call takes the
 * first result after it with its id, where a whole read takes the last
 * anywhere: the same, since providers never give two calls one id. An
 * id given twice still leaves every entry marked, so the walk goes on.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../record.ts";
import {
	logLines,
	ROLLOVER_RECORD,
	type RolloverRecord,
	rolledFrom,
} from "../session/rollover.ts";
import {
	type Asked,
	callsIn,
	entryText,
	type Marked,
	markOf,
	namedBy,
	resultOf,
} from "./recall.ts";

/** What reading the history on disk found, and what it cost. */
export interface OnDisk {
	/** The older branches' entries, oldest first, none the branch holds. */
	readonly marked: Marked[];
	/** How many logs were read. */
	readonly logs: number;
	/** How many bytes they held. */
	readonly bytes: number;
	/** How many entries the older branches held, said or not. */
	readonly entries: number;
	/** The parent that couldn't be read, ending the chain, and why. */
	readonly unread?: { readonly path: string; readonly code: string };
}

/**
 * Every entry the logs `branch` rolled over from held on their
 * branches, marked against `asked`, oldest first and without the
 * entries the branch carried over: what reading each log whole gives,
 * marked as `markEntries` would mark it. A parent gone from disk, or
 * that can't be read, ends the chain there and is named; any other
 * error is the reader's own, and is thrown rather than taken for a
 * missing log.
 */
export function markedOnDisk(
	branch: readonly unknown[],
	asked: Asked,
	lines: LinesOf = logLines,
): OnDisk {
	const seen = new Set(
		branch.map((entry) => (isRecord(entry) ? entry.id : undefined)),
	);
	const older: Marked[][] = [];
	let logs = 0;
	let bytes = 0;
	let record = rolledFrom(branch);
	const visited = new Set<string>();
	let unread: OnDisk["unread"];
	while (record && !visited.has(record.parentSession)) {
		visited.add(record.parentSession);
		let log: LogRead;
		try {
			log = branchMarked(record, asked, lines);
		} catch (error) {
			const code = fileErrorCode(error);
			if (code === undefined) throw error;
			unread = { path: record.parentSession, code };
			break;
		}
		logs++;
		bytes += log.bytes;
		older.unshift(log.walked.filter((mark) => !seen.has(mark.id)));
		for (const mark of log.walked) seen.add(mark.id);
		record = log.next;
	}
	const marked = older.flat();
	return {
		marked,
		logs,
		bytes,
		entries: marked.length,
		...(unread ? { unread } : {}),
	};
}

/** The code of a file system's error, such as ENOENT, or undefined for any other. */
function fileErrorCode(error: unknown): string | undefined {
	return error instanceof Error &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

/** A log's lines, each read's size added to `tally`. */
type LinesOf = (path: string, tally: { bytes: number }) => Iterable<string>;

/** One log's branch, marked, and the record it rolled over from. */
interface LogRead {
	readonly walked: Marked[];
	readonly next: RolloverRecord | undefined;
	readonly bytes: number;
}

/** Where an entry of a log sits, and its mark once it has one. */
interface Slot {
	readonly parentId: string | null;
	mark?: Marked;
}

/** An entry whose calls wait for their results further down the log. */
interface Waiting {
	readonly entry: SessionEntry;
	readonly slot: Slot;
	readonly wants: Set<string>;
	readonly results: Map<string, string>;
	readonly recallCalls: ReadonlySet<string>;
}

/** Mark `record`'s parent log, and walk its branch from the record's leaf. */
function branchMarked(
	record: RolloverRecord,
	asked: Asked,
	lines: LinesOf,
): LogRead {
	const slots = new Map<string, Slot>();
	const records = new Map<string, SessionEntry>();
	const waiting = new Map<string, Waiting>();
	// Every entry still waiting, even one whose call id a later call took.
	const unfinished = new Set<Waiting>();
	const read = { bytes: 0 };

	const finish = (held: Waiting): void => {
		unfinished.delete(held);
		const text = entryText(held.entry, held.results, held.recallCalls);
		held.slot.mark = markOf(
			held.entry.id,
			text,
			asked,
			namedBy(held.entry, asked),
		);
	};

	for (const line of lines(record.parentSession, read)) {
		const entry = entryOf(line);
		if (!entry) continue;
		const slot: Slot = {
			parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		};
		// A later line with the same id is the one a walk reads, as a whole
		// read keeps the last.
		slots.set(entry.id, slot);
		if (entry.type === "custom" && entry.customType === ROLLOVER_RECORD) {
			records.set(entry.id, entry);
		} else {
			records.delete(entry.id);
		}
		const given = resultOf(entry);
		const owner = given && waiting.get(given.callId);
		if (given && owner) {
			waiting.delete(given.callId);
			owner.results.set(given.callId, given.text);
			owner.wants.delete(given.callId);
			if (owner.wants.size === 0) finish(owner);
		}

		const calls = callsIn(entry);
		const asking = calls.filter((call) => !call.recalls);
		const held: Waiting = {
			entry,
			slot,
			wants: new Set(asking.map((call) => call.id)),
			results: new Map(),
			recallCalls: new Set(
				calls.filter((call) => call.recalls).map((call) => call.id),
			),
		};
		if (asking.length === 0) finish(held);
		else unfinished.add(held);
		for (const call of asking) waiting.set(call.id, held);
	}
	// A call whose result never came is read without it.
	for (const held of unfinished) finish(held);

	const walked: Marked[] = [];
	const on = new Set<string>();
	let id: string | null = record.parentLeaf;
	while (id && !on.has(id)) {
		const slot = slots.get(id);
		if (!slot?.mark) break;
		on.add(id);
		walked.push(slot.mark);
		id = slot.parentId;
	}
	walked.reverse();
	const onBranch = walked.flatMap((mark) => {
		const entry = records.get(mark.id);
		return entry ? [entry] : [];
	});
	return { walked, next: rolledFrom(onBranch), bytes: read.bytes };
}

/** The entry a line holds, or nothing for a header, a blank or a cut line. */
function entryOf(line: string): SessionEntry | undefined {
	if (line.trim() === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// A line cut short by a crash is the end of what can be read.
		return undefined;
	}
	return isEntry(parsed) ? parsed : undefined;
}

/**
 * Whether a parsed line is one of pi's entries, read back as pi wrote
 * it: a typed record with an id, as a walk needs, and not the log's
 * header. Every field a mark reads beyond those is checked where it is
 * read.
 */
function isEntry(value: unknown): value is SessionEntry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		value.type !== "session" &&
		typeof value.id === "string"
	);
}
