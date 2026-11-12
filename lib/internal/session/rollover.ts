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
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getCurrentSystemMessage,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import { stateDir } from "../paths.ts";
import { processGlobal } from "../process-global.ts";
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
		...keptBefore(
			branch.slice(0, from),
			options.leftBehind ?? typesLeftBehind(),
		),
		...branch.slice(from),
	];
	const kept = new Set(chosen.map((entry) => entry.id));
	const pointed = chosen.filter((entry) => {
		const field = POINTING[entry.type];
		return field === undefined || kept.has(entry[field] as string);
	});
	const dropped = branch.length - pointed.length;
	if (dropped === 0) return undefined;

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
