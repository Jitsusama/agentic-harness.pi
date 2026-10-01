/**
 * Where the selection keeps its tags and judgements.
 *
 * By default they are custom entries on the session, which persist with
 * it, cost nothing in the conversation, and are billed by the cost
 * ledger from the usage each carries. A host that rebuilds sessions
 * from a log of its own may drop custom entries, and then every tag is
 * lost the moment it is written and every message is tagged again on
 * the next turn. `PI_COMPACTION_SELECTION_STORE=memory` keeps them in
 * the process instead: they last as long as the session's process
 * does, and what they cost is reported on the compaction's record
 * rather than billed by the ledger, which never sees them.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	readHolds,
	SELECTION_HOLDS_ENTRY,
	type SelectionHolds,
} from "../../lib/compaction/selection/holds.ts";
import {
	emptyTagIndex,
	indexTags,
	readTags,
	SELECTION_TAGS_ENTRY,
	type SelectionTags,
	type TagIndex,
} from "../../lib/compaction/selection/tags.ts";

/** The environment variable choosing the store: `session` or `memory`. */
export const SELECTION_STORE_ENV = "PI_COMPACTION_SELECTION_STORE";

/** Which store the selection keeps its records in. */
export type SelectionStoreKind = "session" | "memory";

/** The store the environment names; the session's unless it says memory. */
export function selectionStoreKind(
	env: NodeJS.ProcessEnv = process.env,
): SelectionStoreKind {
	return env[SELECTION_STORE_ENV]?.trim().toLowerCase() === "memory"
		? "memory"
		: "session";
}

/**
 * What the classifier's work took since the last compaction, beside
 * what it cost. The times are milliseconds summed over its calls.
 * Tagging runs a few calls at once, so they are the model's time and
 * not how long anybody waited: nothing waits on tagging. The tokens are
 * there because a catalogue can price a classifier at nothing, and then
 * the spend says nothing while the tokens still say how much it did.
 */
export interface SelectionEffort {
	readonly taggingMs: number;
	readonly judgingMs: number;
	/** Every token the calls used, read and written. */
	readonly tokens: number;
}

/** Tags and judgements, read and recorded. */
export interface SelectionStore {
	readonly kind: SelectionStoreKind;
	/** Every tag known for a branch. */
	tags(branch: readonly SessionEntry[]): TagIndex;
	/** Every judgement since the last compaction, by paragraph hash. */
	holds(branch: readonly SessionEntry[]): Map<string, number>;
	/** What tagging and judging have cost since the last compaction, in dollars. */
	spend(branch: readonly SessionEntry[]): number;
	/** What tagging and judging have taken since the last compaction. */
	effort(branch: readonly SessionEntry[]): SelectionEffort;
	recordTags(tags: SelectionTags): void;
	recordHolds(holds: SelectionHolds): void;
	/** A compaction applied: judgements and spend start over. */
	compacted(): void;
	/** A new session: everything starts over. */
	reset(): void;
}

/** A store of custom entries on the session, through `appendEntry`. */
export function sessionStore(
	appendEntry: (type: string, data: unknown) => void,
): SelectionStore {
	return {
		kind: "session",
		tags: readTags,
		holds: readHolds,
		spend(branch) {
			let total = 0;
			for (const entry of sinceLastCompaction(branch)) {
				if (entry.type !== "custom") continue;
				if (
					entry.customType !== SELECTION_TAGS_ENTRY &&
					entry.customType !== SELECTION_HOLDS_ENTRY
				)
					continue;
				total += costOf(entry.data);
			}
			return total;
		},
		effort(branch) {
			let taggingMs = 0;
			let judgingMs = 0;
			let tokens = 0;
			for (const entry of sinceLastCompaction(branch)) {
				if (entry.type !== "custom") continue;
				if (entry.customType === SELECTION_TAGS_ENTRY) {
					taggingMs += msOf(entry.data);
				} else if (entry.customType === SELECTION_HOLDS_ENTRY) {
					judgingMs += msOf(entry.data);
				} else continue;
				tokens += tokensOf(entry.data);
			}
			return { taggingMs, judgingMs, tokens };
		},
		recordTags: (tags) => appendEntry(SELECTION_TAGS_ENTRY, tags),
		recordHolds: (holds) => appendEntry(SELECTION_HOLDS_ENTRY, holds),
		compacted() {
			// The session holds everything, and reads it from the branch.
		},
		reset() {
			// As above: nothing is held outside the session.
		},
	};
}

/** A store in the process, for a host whose sessions lose custom entries. */
export function memoryStore(): SelectionStore {
	let index = emptyTagIndex();
	let holds = new Map<string, number>();
	let spent = 0;
	let taggingMs = 0;
	let judgingMs = 0;
	let tokens = 0;
	const startOver = () => {
		holds = new Map();
		spent = 0;
		taggingMs = 0;
		judgingMs = 0;
		tokens = 0;
	};
	return {
		kind: "memory",
		tags: () => index,
		holds: () => new Map(holds),
		spend: () => spent,
		effort: () => ({ taggingMs, judgingMs, tokens }),
		recordTags(tags) {
			indexTags(index, tags);
			spent += tags.usage?.cost.total ?? 0;
			taggingMs += msOf(tags);
			tokens += tokensOf(tags);
		},
		recordHolds(recorded) {
			for (const [hash, value] of Object.entries(recorded.holds)) {
				holds.set(hash, value);
			}
			spent += recorded.usage?.cost.total ?? 0;
			judgingMs += msOf(recorded);
			tokens += tokensOf(recorded);
		},
		compacted: startOver,
		reset() {
			index = emptyTagIndex();
			startOver();
		},
	};
}

function sinceLastCompaction(
	branch: readonly SessionEntry[],
): readonly SessionEntry[] {
	let start = 0;
	branch.forEach((entry, at) => {
		if (entry.type === "compaction") start = at + 1;
	});
	return branch.slice(start);
}

function msOf(data: unknown): number {
	if (typeof data !== "object" || data === null || !("ms" in data)) return 0;
	const { ms } = data;
	return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function tokensOf(data: unknown): number {
	if (typeof data !== "object" || data === null) return 0;
	const usage = (data as { usage?: { totalTokens?: unknown } }).usage;
	const total = usage?.totalTokens;
	return typeof total === "number" && Number.isFinite(total) && total > 0
		? total
		: 0;
}

function costOf(data: unknown): number {
	if (typeof data !== "object" || data === null) return 0;
	const usage = (data as { usage?: { cost?: { total?: unknown } } }).usage;
	const total = usage?.cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}
