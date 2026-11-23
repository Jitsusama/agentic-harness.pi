/**
 * Rolling a session over: carrying on in a fresh log that holds only
 * what the model still sees, with the old log named as its parent.
 *
 * pi keeps every entry of a session's log in memory for as long as the
 * session runs, compacted or not, and reads all of it again on every
 * resume. A long session's log outgrows what the model sees by far: one
 * of 318 MB had 20 MB left after its last compaction, and held about
 * 430 MB of heap for the rest. Compaction has already made the rest
 * history, so a fresh log starting at the compaction loses nothing the
 * model reads, and the prompt it builds is the one it built before, so
 * the provider's cache carries on too.
 *
 * What the fresh log keeps:
 *
 * - every entry from the last compaction's first kept entry on, which
 *   is the whole of what the model sees;
 * - before that, every extension's state (`custom` entries), model and
 *   thinking changes and the session's name, in their order, so each
 *   extension rebuilds from the branch exactly as before. A type its
 *   owner said is never read from before the last compaction
 *   (`leaveInParentLog`) stays in the parent log instead, since every
 *   roll would otherwise copy it again;
 * - before that too, the system messages folded into one, which
 *   declares the tools they left declared and removes the ones they
 *   took away. pi builds a resumed session's tools by replaying the
 *   system messages on its branch, and the first of them is the only
 *   one that declares the built-in tools, so a log without it came back
 *   from a restart with no `read`, `bash`, `edit` or `write`. The model
 *   never sees the fold: pi builds context from the compaction on;
 * - a label or context edit only when what it points at is kept;
 * - last, a record naming the parent log and the entry it ended at, and
 *   whatever extensions asked to carry over (`carried`), such as the
 *   session's spend so far.
 *
 * Abandoned branches, older summaries and the conversation compaction
 * summarised stay in the parent log, where `session_recall` reads them.
 * Entry ids are kept, so a reference to one still resolves, and the
 * ledger, which names a turn by its id and time, bills a copied turn
 * once.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	read as readWithoutBlocking,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	getCurrentSystemMessage,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import { stateDir } from "../paths.ts";
import { processGlobal } from "../process/process-global.ts";
import { uuidv7 } from "./uuidv7.ts";

/** The bus event asking extensions what to carry over; see `Carry`. */
export const ROLLOVER_CARRY = "session:rollover-carry:v1";

/** The custom entry type of the record that ends a rolled-over log. */
export const ROLLOVER_RECORD = "session-rollover";

/**
 * A log this large or larger rolls over at its next compaction. Below
 * it, the history a session holds costs less than the moment it would
 * take to notice. On 5 November a resumed 32.8 MB log gave back 124 MB
 * of its 389 MB three minutes after rolling over, and a 20 MB one 32 MB
 * of 275 MB, so smaller logs are left alone.
 */
export const ROLLOVER_BYTES = 32 * 1024 * 1024;

/**
 * Set to `on` for a session to roll over by itself, or `off` to keep it
 * from doing so whatever {@link rolloverSwitch} says.
 */
export const ROLLOVER_ENV = "PI_ROLLOVER";

/**
 * The file that turns rollover on for sessions already running, read at
 * each compaction: a line `on` turns it on for every session, and a line
 * holding a session's id asks that session alone to roll over at its
 * next compaction, whatever its log's size, as `/rollover` would. A
 * session's environment reaches it only at its start, and on 6 November
 * 76 sessions ran that could only have been turned on by restarting
 * them, so one is proven and the rest follow without a restart.
 */
export function rolloverSwitch(): string {
	return join(stateDir("rollover-workflow"), "switch");
}

/**
 * Whether a compaction rolls session `id` over: `off`; `large`, when its
 * log has reached {@link ROLLOVER_BYTES}; or `now`, whatever its size.
 * {@link ROLLOVER_ENV} set to `off` keeps it off; otherwise a line
 * naming it says `now`, and the variable set to `on` or a line `on` says
 * `large`. No switch and no variable leave it off.
 */
export function rolloverAsked(
	id: string,
	env: NodeJS.ProcessEnv = process.env,
	switchPath: string = rolloverSwitch(),
): "off" | "large" | "now" {
	const said = env[ROLLOVER_ENV]?.trim();
	if (said === "off") return "off";
	let lines: string[] = [];
	try {
		lines = readFileSync(switchPath, "utf8")
			.split("\n")
			.map((line) => line.trim());
	} catch {
		// No switch is the usual case: the variable alone decides.
	}
	if (id !== "" && lines.includes(id)) return "now";
	return said === "on" || lines.includes("on") ? "large" : "off";
}

/**
 * What a rollover asks of extensions on the bus before it writes: each
 * puts what it must carry under its own name, and finds it again in the
 * record (`carriedBy`) when the fresh log starts.
 */
export interface Carry {
	readonly carried: Record<string, unknown>;
}

/** The record a rolled-over log ends with. */
export interface RolloverRecord {
	/** The log this one carries on from. */
	readonly parentSession: string;
	/** The parent's last entry, where its branch ended. */
	readonly parentLeaf: string;
	/** Entries left in the parent. */
	readonly dropped: number;
	readonly carried: Record<string, unknown>;
}

/** An entry as a log holds it; only the fields a rollover reads. */
export interface Entry {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly [field: string]: unknown;
}

/** The header line of a log. */
export interface Header {
	readonly type: "session";
	readonly version?: number;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly parentSession?: string;
}

/** A fresh log, ready to write. */
export interface Rolled {
	readonly header: Header;
	readonly entries: readonly Entry[];
	readonly record: RolloverRecord;
}

/** Entry types that hold state rather than conversation. */
const STATE = new Set([
	"custom",
	"model_change",
	"thinking_level_change",
	"session_info",
]);

/** Types that point at another entry, kept only when it is kept. */
const POINTING: Record<string, string> = {
	label: "targetId",
	context_edit: "targetId",
};

/** The name pi gives a log started at `at` with id `id`. */
export function sessionFileName(id: string, at: Date): string {
	return `${at.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

/** The record on a branch, the latest when there are several. */
export function rolledFrom(
	branch: readonly unknown[],
): RolloverRecord | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as Partial<Entry> | undefined;
		if (entry?.type !== "custom" || entry.customType !== ROLLOVER_RECORD) {
			continue;
		}
		const data = entry.data as Partial<RolloverRecord> | undefined;
		if (
			typeof data?.parentSession === "string" &&
			typeof data.parentLeaf === "string"
		) {
			return {
				parentSession: data.parentSession,
				parentLeaf: data.parentLeaf,
				dropped: typeof data.dropped === "number" ? data.dropped : 0,
				carried:
					typeof data.carried === "object" && data.carried !== null
						? data.carried
						: {},
			};
		}
	}
	return undefined;
}

/** Where on a branch its record sits, or -1 when it has none. */
export function recordIndex(branch: readonly unknown[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as Partial<Entry> | undefined;
		if (entry?.type === "custom" && entry.customType === ROLLOVER_RECORD) {
			return i;
		}
	}
	return -1;
}

/**
 * The tools pi declares by itself rather than for an extension. Only a
 * session's first system message names them, and pi does not declare
 * one again on a resume that the system messages leave out.
 */
export const PI_BUILT_IN_TOOLS: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/**
 * The built-in tools a log rolled over before system messages were
 * folded cannot give back: the ones its first compaction still declared
 * and that no system message on the branch has declared since. Such a
 * log kept no system message from before its first kept entry, so pi,
 * which rebuilds a resumed session's tools from the system messages,
 * resumes it without them. Empty for any other log.
 */
export function builtInsLostToRollover(branch: readonly unknown[]): string[] {
	if (!rolledFrom(branch)) return [];
	const entries = branch as readonly Partial<Entry>[];
	const compaction = entries.find((entry) => entry?.type === "compaction");
	const firstKept = entries.findIndex(
		(entry) => entry?.id === compaction?.firstKeptEntryId,
	);
	if (!compaction || firstKept === -1) return [];
	if (entries.slice(0, firstKept).some(isSystemEntry)) return [];
	const snapshot = compaction.systemMessage as SystemMessage | undefined;
	const declaredSince = new Set(
		entries
			.filter(isSystemEntry)
			.flatMap((entry) => entry.message.toolsAdded ?? [])
			.map((tool) => tool.name),
	);
	return (snapshot?.toolsAdded ?? [])
		.map((tool) => tool.name)
		.filter(
			(name) => PI_BUILT_IN_TOOLS.includes(name) && !declaredSince.has(name),
		);
}

/** What one extension carried over, or undefined when it carried nothing. */
export function carriedBy(branch: readonly unknown[], name: string): unknown {
	return rolledFrom(branch)?.carried[name];
}

/** Whether an entry is a system message, which declares prompt and tools. */
export function isSystemEntry(
	entry: Partial<Entry> | undefined,
): entry is Entry & { readonly message: SystemMessage } {
	if (entry?.type !== "message") return false;
	const message = entry.message as { role?: unknown } | undefined;
	return message?.role === "system";
}

/**
 * Several system messages as one that leaves pi in the same place when
 * it replays them: the same prompt and sections, the same tools
 * declared, and every tool they ever named. A tool they removed and
 * never declared again is removed in the fold too, since pi treats an
 * extension's tool no system message names as new and declares it,
 * which would bring back a tool the session had put away.
 */
export function foldSystemMessages(
	messages: readonly SystemMessage[],
): SystemMessage | undefined {
	const current = getCurrentSystemMessage(messages);
	if (!current) return undefined;
	const declared = new Set((current.toolsAdded ?? []).map((tool) => tool.name));
	const named = new Set(
		messages.flatMap((message) =>
			[...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])].map(
				(tool) => tool.name,
			),
		),
	);
	const removed = [...named]
		.filter((name) => !declared.has(name))
		.map((name) => ({ name }));
	const last = messages[messages.length - 1];
	return {
		...current,
		...(removed.length > 0 ? { toolsRemoved: removed } : {}),
		timestamp: last?.timestamp ?? current.timestamp,
	};
}

/**
 * The entries before the first kept one that a fresh log keeps: the
 * state, in its order, and the system messages folded into one where
 * the last of them stood, under its id.
 */
function keptBefore(
	before: readonly Entry[],
	leftBehind: ReadonlySet<string>,
): Entry[] {
	const systems = before.filter(isSystemEntry);
	const last = systems[systems.length - 1];
	const folded = foldSystemMessages(systems.map((entry) => entry.message));
	return before.flatMap((entry): Entry[] => {
		if (isSystemEntry(entry)) {
			return entry === last && folded ? [{ ...entry, message: folded }] : [];
		}
		const state =
			STATE.has(entry.type) &&
			!(
				entry.type === "custom" &&
				(entry.customType === ROLLOVER_RECORD ||
					(typeof entry.customType === "string" &&
						leftBehind.has(entry.customType)))
			);
		return state ? [entry] : [];
	});
}

/** The custom types every load in this process said a roll leaves behind. */
function typesLeftBehind(): Set<string> {
	return processGlobal(
		"pi:harness:rollover-leaves-behind:v1",
		() => new Set<string>(),
	);
}

/**
 * Say that entries of `customType` are records, never read from before
 * the last compaction, so a rollover leaves them in the parent log
 * rather than copying them into the fresh one. `session_recall` still
 * reads them there. A type something rebuilds its state from must never
 * be named here: the fresh log would start without it.
 */
export function leaveInParentLog(customType: string): void {
	typesLeftBehind().add(customType);
}

/** An id no entry in `taken` has, in pi's eight-hex form. */
function freshId(taken: ReadonlySet<string>): string {
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (!taken.has(id)) return id;
	}
}

/** What a branch keeps after its last compaction, and where that starts. */
export interface KeptView {
	/** The kept entries in branch order, their parents as the branch had them. */
	readonly entries: readonly Entry[];
	/** The branch's index of the compaction's first kept entry. */
	readonly from: number;
	/** How many of the branch's entries the view leaves out. */
	readonly dropped: number;
}

/**
 * The entries of `branch` that a rollover keeps: the state before the
 * last compaction's first kept entry, the system messages folded, and
 * everything from that entry on. Undefined when the branch has no
 * compaction to start from, names a first kept entry it does not hold,
 * or would leave nothing out. A rolled log and a hosted conversation
 * held in memory both keep this, so the two can never disagree.
 */
export function keptView(
	branch: readonly Entry[],
	leftBehind: ReadonlySet<string> = typesLeftBehind(),
): KeptView | undefined {
	let compaction = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") {
			compaction = i;
			break;
		}
	}
	if (compaction === -1) return undefined;
	const firstKept = branch[compaction]?.firstKeptEntryId;
	const from = branch.findIndex((entry) => entry.id === firstKept);
	// An id the branch does not hold is a log pi itself could not build
	// a context from; better to leave it as it is.
	if (from === -1 || from > compaction) return undefined;

	const chosen = [
		...keptBefore(branch.slice(0, from), leftBehind),
		...branch.slice(from),
	];
	const kept = new Set(chosen.map((entry) => entry.id));
	const entries = chosen.filter((entry) => {
		const field = POINTING[entry.type];
		return field === undefined || kept.has(entry[field] as string);
	});
	const dropped = branch.length - entries.length;
	if (dropped === 0) return undefined;
	return { entries, from, dropped };
}

/**
 * The fresh log for a branch, or undefined when it has no compaction to
 * start from or nothing before it to leave behind.
 */
export function rollOver(
	branch: readonly Entry[],
	options: {
		readonly parentSession: string;
		readonly cwd: string;
		readonly version?: number;
		readonly carried?: Record<string, unknown>;
		readonly now?: Date;
		readonly id?: string;
		/** Custom types to leave behind; every `leaveInParentLog` by default. */
		readonly leftBehind?: ReadonlySet<string>;
	},
): Rolled | undefined {
	const view = keptView(branch, options.leftBehind ?? typesLeftBehind());
	if (!view) return undefined;
	const { entries: pointed, dropped } = view;
	const kept = new Set(pointed.map((entry) => entry.id));

	const leaf = branch[branch.length - 1];
	if (!leaf) return undefined;
	const now = options.now ?? new Date();
	const record: RolloverRecord = {
		parentSession: options.parentSession,
		parentLeaf: leaf.id,
		dropped,
		carried: options.carried ?? {},
	};
	// Each entry's parent becomes the one before it, which is what it was
	// on the branch for every entry from the first kept one on.
	const entries: Entry[] = [];
	let parentId: string | null = null;
	for (const entry of pointed) {
		entries.push({ ...entry, parentId });
		parentId = entry.id;
	}
	entries.push({
		type: "custom",
		id: freshId(kept),
		parentId,
		timestamp: now.toISOString(),
		customType: ROLLOVER_RECORD,
		data: record,
	});
	const header: Header = {
		type: "session",
		...(options.version === undefined ? {} : { version: options.version }),
		id: options.id ?? uuidv7(now.getTime()),
		timestamp: now.toISOString(),
		cwd: options.cwd,
		parentSession: options.parentSession,
	};
	return { header, entries, record };
}

/**
 * The branch a log held where it was rolled over, read from disk: from
 * its root to `leaf`, or to its last entry without one.
 */
function branchIn(
	path: string,
	leaf: string | undefined,
	read: (path: string) => string,
): Entry[] {
	const byId = new Map<string, Entry>();
	let last: Entry | undefined;
	for (const line of read(path).split("\n")) {
		if (line.trim() === "") continue;
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			// A line cut short by a crash is the end of what can be read.
			continue;
		}
		if (entry.type === "session" || typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
		last = entry;
	}
	const walked: Entry[] = [];
	let at = leaf === undefined ? last : byId.get(leaf);
	while (at) {
		walked.push(at);
		at = at.parentId ? byId.get(at.parentId) : undefined;
	}
	return walked.reverse();
}

/**
 * Everything the logs this one rolled over from held on their branches,
 * oldest first and without the entries this branch carried over, so a
 * search of the session reads its whole history. Read from disk on
 * asking and never kept: a parent can be hundreds of megabytes. A
 * parent gone from disk ends the chain there.
 */
export function ancestry(
	branch: readonly unknown[],
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Entry[] {
	const seen = new Set(
		branch.map((entry) => (entry as Partial<Entry> | undefined)?.id),
	);
	const older: Entry[][] = [];
	let record = rolledFrom(branch);
	const visited = new Set<string>();
	while (record && !visited.has(record.parentSession)) {
		visited.add(record.parentSession);
		let parent: Entry[];
		try {
			parent = branchIn(record.parentSession, record.parentLeaf, read);
		} catch {
			break;
		}
		older.unshift(parent.filter((entry) => !seen.has(entry.id)));
		for (const entry of parent) seen.add(entry.id);
		record = rolledFrom(parent);
	}
	return older.flat();
}

/** How much of a parent log is read at once. */
const CHUNK_BYTES = 1024 * 1024;

/** The byte that ends each line of a log. */
const NEWLINE = 0x0a;

/** How pi starts each message line it writes. */
const MESSAGE_HEAD = Buffer.from('{"type":"message","id":"');

/** What marks a line that could be a message, whatever order it was written in. */
const MESSAGE_TYPE = Buffer.from('"type":"message"');

/** What marks a line that could be a rollover record. */
const RECORD_TYPE = Buffer.from(`"customType":"${ROLLOVER_RECORD}"`);

/** The byte that ends a message's id. */
const QUOTE = 0x22;

/**
 * How a parent log is opened: without blocking, so a pipe is refused
 * rather than waited on, and never as the host's terminal, should a
 * parent name one, before it is found not to be a file.
 */
const READ_FLAGS =
	constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;

/**
 * What readers of one session's parent logs have learnt: where each
 * message they found sits, and which they found in no log of the
 * chain. A message never changes once written and a log only grows at
 * its end, so a later read goes straight to a line found before, after
 * checking it still holds that message, and skips an id found nowhere.
 * It starts afresh when the branch carries on from another log.
 */
export interface DiskFinds {
	/** The log the branch carried on from when these were learnt. */
	from?: string;
	readonly located: Map<string, Located>;
	readonly absent: Set<string>;
	/** How many parent logs have been scanned for messages, in all. */
	scanned: number;
}

/** Where a message was found: its log, how far back, and its line's bytes. */
interface Located {
	readonly path: string;
	/** 0 for the log the branch carries on from, 1 for that log's parent. */
	readonly depth: number;
	readonly offset: number;
	readonly length: number;
}

/** Nothing learnt yet, for a reader to keep between reads. */
export function diskFinds(): DiskFinds {
	return { located: new Map(), absent: new Set(), scanned: 0 };
}

/**
 * The messages among `wanted` that the logs this one carries on from
 * hold, oldest first and without those on the branch, for a reader
 * that needs a few old messages back rather than the whole history.
 * Each parent is read a chunk at a time, and a line is decoded and
 * parsed only when it is a wanted message or a rollover record, so
 * reading costs little more than scanning the bytes. No log is opened
 * when every wanted message is on the branch or in `finds`, and the
 * walk ends once all are found. A parent gone from disk, or not a
 * regular file, ends the chain there, and what is still missing counts
 * as found nowhere; a parent unreadable for another reason ends it
 * too, but leaves what is missing to be looked for again.
 */
export function messagesOnDisk(
	branch: readonly unknown[],
	wanted: ReadonlySet<string>,
	finds: DiskFinds = diskFinds(),
): Entry[] {
	const scan = scanParents(branch, wanted, finds);
	let step = scan.next();
	while (!step.done) {
		const { fd, buffer, length, position } = step.value;
		let read: number;
		try {
			read = readSync(fd, buffer, 0, length, position);
		} catch (error) {
			step = scan.throw(error);
			continue;
		}
		step = scan.next(read);
	}
	return step.value;
}

/** How a reader that can wait reads. */
export interface PacedRead {
	/** Once aborted, the read stops, giving back nothing. */
	readonly signal?: AbortSignal;
	/** What earlier reads learnt, and where this one leaves what it learns. */
	readonly finds?: DiskFinds;
}

/**
 * As {@link messagesOnDisk}, for a reader that can wait: each chunk and
 * each line found before is read without blocking the event loop, so
 * the conversation goes on while the disk answers, and between reads
 * the loop holds only for the lines of one chunk. A line longer than a
 * chunk is joined and judged once its last piece is read.
 */
export async function messagesOnDiskAsync(
	branch: readonly unknown[],
	wanted: ReadonlySet<string>,
	{ signal, finds = diskFinds() }: PacedRead = {},
): Promise<Entry[]> {
	const scan = scanParents(branch, wanted, finds);
	try {
		let step = scan.next();
		while (!step.done) {
			let read: number;
			try {
				read = await readAsync(step.value);
			} catch (error) {
				if (signal?.aborted) return [];
				step = scan.throw(error);
				continue;
			}
			if (signal?.aborted) return [];
			step = scan.next(read);
		}
		return step.value;
	} finally {
		// Closes any log a stopped scan still holds open.
		scan.return([]);
	}
}

/** A read the scan needs done: `length` bytes of `fd` at `position`. */
interface ReadWanted {
	readonly fd: number;
	readonly buffer: Buffer;
	readonly length: number;
	readonly position: number;
}

/**
 * A walk over parent logs that leaves its reads to whoever drives it:
 * it yields each read it needs and is given back how many bytes came,
 * or the error thrown in, so one walk serves a reader that blocks and
 * one that awaits.
 */
type Scan<T> = Generator<ReadWanted, T, number>;

/** The read `wanted`, done without blocking the event loop. */
function readAsync({ fd, buffer, length, position }: ReadWanted) {
	return new Promise<number>((resolve, reject) => {
		readWithoutBlocking(fd, buffer, 0, length, position, (error, bytes) =>
			error ? reject(error) : resolve(bytes),
		);
	});
}

/** How many bytes of `fd` at `position` came into `buffer`. */
function* readOf(
	fd: number,
	buffer: Buffer,
	length: number,
	position: number,
): Scan<number> {
	return yield { fd, buffer, length, position };
}

/** The walk both readers share, returning the messages found. */
function* scanParents(
	branch: readonly unknown[],
	wanted: ReadonlySet<string>,
	finds: DiskFinds,
): Scan<Entry[]> {
	const seen = new Set(
		branch.map((entry) => (entry as Partial<Entry> | undefined)?.id),
	);
	let record = rolledFrom(branch);
	if (finds.from !== record?.parentSession) {
		finds.located.clear();
		finds.absent.clear();
		finds.from = record?.parentSession;
	}
	const missing = new Set(
		[...wanted].filter((id) => !seen.has(id) && !finds.absent.has(id)),
	);
	const found = yield* foundBefore(missing, finds);
	const visited = new Set<string>();
	let depth = 0;
	let ended = true;
	while (missing.size > 0 && record && !visited.has(record.parentSession)) {
		const path = record.parentSession;
		visited.add(path);
		finds.scanned++;
		let next: RolloverRecord | undefined;
		const within = depth;
		let aLog: boolean;
		try {
			aLog = yield* linesOf(path, (line, offset) => {
				const entry = wantedLine(line, missing);
				if (entry?.type !== "message") {
					if (entry) next = rolledFrom([entry]) ?? next;
					return false;
				}
				const at = { path, depth: within, offset, length: line.length };
				found.push({ at, entry });
				finds.located.set(entry.id, at);
				// An older log may hold it again; the newest copy is the one read.
				missing.delete(entry.id);
				return missing.size === 0;
			});
		} catch (error) {
			// A parent gone from disk ends the chain there for good, and what
			// is still missing counts as found nowhere. One unreadable for a
			// while ends it too, keeping what it gave, but what is still
			// missing may yet be read.
			if (!goneForGood(error)) ended = false;
			break;
		}
		// A parent that is not a regular file, such as a pipe, ends it too.
		if (!aLog) break;
		record = next;
		depth++;
	}
	if (ended) for (const id of missing) finds.absent.add(id);
	// Oldest first: the furthest log back, then each log's own order.
	found.sort((a, b) => b.at.depth - a.at.depth || a.at.offset - b.at.offset);
	return found.map(({ entry }) => entry);
}

/** Whether a read failed because the log is not there, which lasts. */
function goneForGood(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** A message read back, and where it was. */
interface Found {
	readonly at: Located;
	readonly entry: Entry;
}

/**
 * The missing messages an earlier read found, read straight from their
 * lines and taken out of `missing`. A line that no longer holds its
 * message is forgotten, so a scan looks for that message again.
 */
function* foundBefore(missing: Set<string>, finds: DiskFinds): Scan<Found[]> {
	const found: Found[] = [];
	for (const id of [...missing]) {
		const at = finds.located.get(id);
		if (!at) continue;
		const entry = yield* lineAt(at, id);
		if (entry) {
			found.push({ at, entry });
			missing.delete(id);
		} else {
			finds.located.delete(id);
		}
	}
	return found;
}

/** The message `id` at `at`, if that line still holds it. */
function* lineAt(at: Located, id: string): Scan<Entry | undefined> {
	let fd: number | undefined;
	try {
		fd = openSync(at.path, READ_FLAGS);
		if (!fstatSync(fd).isFile()) return undefined;
		const bytes = Buffer.alloc(at.length);
		if ((yield* readOf(fd, bytes, at.length, at.offset)) !== at.length)
			return undefined;
		const entry = wantedLine(bytes, new Set([id]));
		return entry?.type === "message" ? entry : undefined;
	} catch {
		// A log gone or unreadable: a scan will say what is there now.
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The entry a line holds when it is a missing message or a rollover
 * record. A line pi starts as a message is judged by the id in its
 * bytes, and any other by whether its bytes name a message or a record,
 * so no other line is decoded or parsed.
 */
function wantedLine(
	line: Buffer,
	missing: ReadonlySet<string>,
): Entry | undefined {
	if (line.subarray(0, MESSAGE_HEAD.length).equals(MESSAGE_HEAD)) {
		const end = line.indexOf(QUOTE, MESSAGE_HEAD.length);
		const id = line.toString(
			"utf8",
			MESSAGE_HEAD.length,
			end === -1 ? line.length : end,
		);
		if (!missing.has(id)) return undefined;
	} else if (
		line.indexOf(MESSAGE_TYPE) === -1 &&
		line.indexOf(RECORD_TYPE) === -1
	) {
		return undefined;
	}
	let entry: Entry;
	try {
		entry = JSON.parse(line.toString("utf8")) as Entry;
	} catch {
		// A line cut short by a crash holds nothing to read.
		return undefined;
	}
	if (entry.type === "message")
		return missing.has(entry.id) ? entry : undefined;
	return entry.type === "custom" && entry.customType === ROLLOVER_RECORD
		? entry
		: undefined;
}

/**
 * A file's lines, read a chunk at a time and handed over as bytes.
 *
 * Lines are cut at their newline bytes, so a reader decodes only the
 * lines it wants, and a line decoded alone reads exactly as it would in
 * the whole file: no byte of a multibyte UTF-8 letter is a newline. A
 * line that fits in one chunk is a view of a buffer read into again, so
 * `take` must be done with it before it returns. `take` is given each
 * line and where in the file it starts, and returns true to stop.
 *
 * Only a regular file is read. A pipe or a device named as a parent
 * could block a read for good, so anything else is left unread, and
 * false is returned for it.
 */
function* linesOf(
	path: string,
	take: (line: Buffer, offset: number) => boolean,
): Scan<boolean> {
	const fd = openSync(path, READ_FLAGS);
	try {
		if (!fstatSync(fd).isFile()) return false;
		const buffer = Buffer.alloc(CHUNK_BYTES);
		// A long line spans chunks: its pieces wait here, joined once it ends.
		let held: Buffer[] = [];
		let heldAt = 0;
		let base = 0;
		for (;;) {
			const read = yield* readOf(fd, buffer, CHUNK_BYTES, base);
			if (read === 0) break;
			const chunk = buffer.subarray(0, read);
			let start = 0;
			let end = chunk.indexOf(NEWLINE);
			if (end !== -1 && held.length > 0) {
				if (take(Buffer.concat([...held, chunk.subarray(0, end)]), heldAt))
					return true;
				held = [];
				start = end + 1;
				end = chunk.indexOf(NEWLINE, start);
			}
			for (; end !== -1; end = chunk.indexOf(NEWLINE, start)) {
				if (take(chunk.subarray(start, end), base + start)) return true;
				start = end + 1;
			}
			// The buffer is read into again, so what waits is a copy.
			if (start < read) {
				if (held.length === 0) heldAt = base + start;
				held.push(Buffer.from(chunk.subarray(start)));
			}
			base += read;
		}
		if (held.length > 0) take(Buffer.concat(held), heldAt);
		return true;
	} finally {
		closeSync(fd);
	}
}

/**
 * Write a fresh log into `dir` whole, under a temporary name first, so
 * no reader ever finds half of one. Returns its path.
 */
export function writeRolled(dir: string, rolled: Rolled): string {
	const path = join(
		dir,
		sessionFileName(rolled.header.id, new Date(rolled.header.timestamp)),
	);
	const lines = [rolled.header, ...rolled.entries]
		.map((line) => JSON.stringify(line))
		.join("\n");
	const partial = `${path}.partial`;
	writeFileSync(partial, `${lines}\n`, { encoding: "utf8", flag: "wx" });
	renameSync(partial, path);
	return path;
}
