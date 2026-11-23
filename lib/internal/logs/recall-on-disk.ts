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
 * call and its result are never split across two. Read a line at a
 * time, a call takes the first result after it with its id, where a
 * whole read takes the last one on the branch. The two differ only in
 * a log pi would not write: a call id given twice, a result before its
 * call or off the branch, or an id written on two lines. Such a log is
 * noticed as it is read, and the calls it touches are read again in a
 * second pass that holds only them and their results, so the answer is
 * the whole read's. Where two logs share a call id, each log's calls
 * read with its own results, where a whole read of every log took the
 * last of them all.
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
	/**
	 * The parent that couldn't be read, ending the chain, and why: the
	 * file system's code, or that it holds none of its record's branch.
	 */
	readonly unread?: { readonly path: string; readonly reason: string };
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
			unread = { path: record.parentSession, reason: code };
			break;
		}
		if (log.walked.length === 0) {
			// Not a regular file, or one without the record's leaf.
			unread = { path: record.parentSession, reason: NO_BRANCH };
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

/** Why a parent that gives no branch ends the chain. */
export const NO_BRANCH = "it holds none of the branch its record names";

/**
 * The code of a failed system call, such as ENOENT, or undefined for
 * any other error: Node's own faults carry a code too, as ERR_ ones,
 * but no system call.
 */
function fileErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	if (!("syscall" in error) || typeof error.syscall !== "string") {
		return undefined;
	}
	return "code" in error && typeof error.code === "string"
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

/** Where an entry of a log sits, its mark, and how its calls were read. */
interface Slot {
	readonly parentId: string | null;
	mark?: Marked;
	/** The ids of the calls it makes, recall's own included. */
	calls?: readonly string[];
	/** The result entry each of its calls was read with, by call id. */
	paired?: Map<string, string>;
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
	// What tells a log pi would not write, where pairing a call with the
	// result after it may not be the whole read's pairing.
	const claimed = new Set<string>();
	const answered = new Set<string>();
	const irregular = new Set<string>();
	let rewritten = false;
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
		if (slots.has(entry.id)) rewritten = true;
		slots.set(entry.id, slot);
		if (entry.type === "custom" && entry.customType === ROLLOVER_RECORD) {
			records.set(entry.id, entry);
		} else {
			records.delete(entry.id);
		}
		const given = resultOf(entry);
		const owner = given && waiting.get(given.callId);
		// A result answers the call before it, recall's own included; one
		// with no call yet, or a second for the same id, is irregular.
		if (given) {
			if (!claimed.has(given.callId) || answered.has(given.callId)) {
				irregular.add(given.callId);
			}
			answered.add(given.callId);
		}
		if (given && owner) {
			waiting.delete(given.callId);
			owner.results.set(given.callId, given.text);
			owner.slot.paired ??= new Map();
			owner.slot.paired.set(given.callId, entry.id);
			owner.wants.delete(given.callId);
			if (owner.wants.size === 0) finish(owner);
		}

		const calls = callsIn(entry);
		for (const call of calls) {
			if (claimed.has(call.id)) irregular.add(call.id);
			claimed.add(call.id);
		}
		if (calls.length > 0) slot.calls = calls.map((call) => call.id);
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

	const touched = new Set<string>();
	const callIds = new Set<string>();
	for (const mark of walked) {
		const slot = slots.get(mark.id);
		if (!slot?.calls) continue;
		const offBranch = [...(slot.paired?.values() ?? [])].some(
			(result) => !on.has(result),
		);
		if (rewritten || offBranch || slot.calls.some((c) => irregular.has(c))) {
			touched.add(mark.id);
			for (const call of slot.calls) callIds.add(call);
		}
	}
	if (touched.size > 0) {
		const again = markedAgain(record, walked, touched, callIds, asked, lines);
		read.bytes += again.bytes;
		walked.forEach((mark, at) => {
			const remarked = again.marks.get(mark.id);
			if (remarked) walked[at] = remarked;
		});
	}

	const onBranch = walked.flatMap((mark) => {
		const entry = records.get(mark.id);
		return entry ? [entry] : [];
	});
	return { walked, next: rolledFrom(onBranch), bytes: read.bytes };
}

/**
 * Mark again, as a whole read marks them, the `touched` entries of a
 * log pi would not write: each of their calls read with the last
 * result for its id on the branch. Only they and the results of
 * `callIds` are held, and `walked` gives the branch and its order.
 */
function markedAgain(
	record: RolloverRecord,
	walked: readonly Marked[],
	touched: ReadonlySet<string>,
	callIds: ReadonlySet<string>,
	asked: Asked,
	lines: LinesOf,
): { marks: Map<string, Marked>; bytes: number } {
	const on = new Set(walked.map((mark) => mark.id));
	const entries = new Map<string, SessionEntry>();
	const results = new Map<string, { callId: string; text: string }>();
	const recalling = new Map<string, string[]>();
	const read = { bytes: 0 };
	for (const line of lines(record.parentSession, read)) {
		const entry = entryOf(line);
		if (!entry || !on.has(entry.id)) continue;
		// The last line given an id is the one kept, as on the first pass.
		if (touched.has(entry.id)) entries.set(entry.id, entry);
		const given = resultOf(entry);
		if (given && callIds.has(given.callId)) results.set(entry.id, given);
		else results.delete(entry.id);
		const recalls = callsIn(entry)
			.filter((call) => call.recalls && callIds.has(call.id))
			.map((call) => call.id);
		if (recalls.length > 0) recalling.set(entry.id, recalls);
		else recalling.delete(entry.id);
	}
	// In the branch's order, as a whole read meets them: the last wins.
	const byCall = new Map<string, string>();
	const recallCalls = new Set<string>();
	for (const mark of walked) {
		const given = results.get(mark.id);
		if (given) byCall.set(given.callId, given.text);
		for (const call of recalling.get(mark.id) ?? []) recallCalls.add(call);
	}
	const marks = new Map<string, Marked>();
	for (const [id, entry] of entries) {
		const text = entryText(entry, byCall, recallCalls);
		marks.set(id, markOf(id, text, asked, namedBy(entry, asked)));
	}
	return { marks, bytes: read.bytes };
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
 * Whether a parsed line is an entry as a walk needs it: a record with
 * an id, and not the log's header, as a whole read takes it. Every
 * field a mark reads beyond those is checked where it is read, so a
 * line that parses but that pi never wrote is walked through and says
 * nothing.
 */
function isEntry(value: unknown): value is SessionEntry {
	return (
		isRecord(value) && value.type !== "session" && typeof value.id === "string"
	);
}
