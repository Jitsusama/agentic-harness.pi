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
 * call and its result are never split across two.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../record.ts";
import {
	type Entry,
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
}

/**
 * Every entry the logs `branch` rolled over from held on their
 * branches, marked against `asked`, oldest first and without the
 * entries the branch carried over: what `ancestry` reads, marked as
 * `markEntries` would mark it. A parent gone from disk ends the chain
 * there.
 */
export function markedOnDisk(
	branch: readonly unknown[],
	asked: Asked,
	lines: (path: string) => Iterable<string> = logLines,
): OnDisk {
	const seen = new Set(
		branch.map((entry) => (isRecord(entry) ? entry.id : undefined)),
	);
	const older: Marked[][] = [];
	let logs = 0;
	let bytes = 0;
	let record = rolledFrom(branch);
	const visited = new Set<string>();
	while (record && !visited.has(record.parentSession)) {
		visited.add(record.parentSession);
		let log: LogRead;
		try {
			log = branchMarked(record, asked, lines);
		} catch {
			// A parent gone from disk, or unreadable, ends the chain there.
			break;
		}
		logs++;
		bytes += log.bytes;
		older.unshift(log.walked.filter((mark) => !seen.has(mark.id)));
		for (const mark of log.walked) seen.add(mark.id);
		record = log.next;
	}
	const marked = older.flat();
	return { marked, logs, bytes, entries: marked.length };
}

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
	lines: (path: string) => Iterable<string>,
): LogRead {
	const slots = new Map<string, Slot>();
	const records = new Map<string, Entry>();
	const waiting = new Map<string, Waiting>();
	let bytes = 0;

	const finish = (held: Waiting): void => {
		const text = entryText(held.entry, held.results, held.recallCalls);
		held.slot.mark = markOf(
			held.entry.id,
			text,
			asked,
			namedBy(held.entry, asked),
		);
	};

	for (const line of lines(record.parentSession)) {
		// Each line but a cut last one was ended by a newline; a byte over
		// for that one is nothing to a journal's size.
		bytes += Buffer.byteLength(line) + 1;
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
		// The parse is pi's own entry, read back as it wrote it.
		const session = entry as unknown as SessionEntry;

		const given = resultOf(session);
		const owner = given && waiting.get(given.callId);
		if (given && owner) {
			waiting.delete(given.callId);
			owner.results.set(given.callId, given.text);
			owner.wants.delete(given.callId);
			if (owner.wants.size === 0) finish(owner);
		}

		const calls = callsIn(session);
		const asking = calls.filter((call) => !call.recalls);
		const held: Waiting = {
			entry: session,
			slot,
			wants: new Set(asking.map((call) => call.id)),
			results: new Map(),
			recallCalls: new Set(
				calls.filter((call) => call.recalls).map((call) => call.id),
			),
		};
		if (asking.length === 0) finish(held);
		for (const call of asking) waiting.set(call.id, held);
	}
	// A call whose result never came is read without it.
	for (const held of new Set(waiting.values())) finish(held);

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
	return { walked, next: rolledFrom(onBranch), bytes };
}

/** The entry a line holds, or nothing for a header, a blank or a cut line. */
function entryOf(line: string): Entry | undefined {
	if (line.trim() === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// A line cut short by a crash is the end of what can be read.
		return undefined;
	}
	return isEntry(parsed) && parsed.type !== "session" ? parsed : undefined;
}

/** Whether a parsed line is an entry with an id, as a walk needs. */
function isEntry(value: unknown): value is Entry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		typeof value.id === "string"
	);
}
