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

/** Tags and judgements, read and recorded. */
export interface SelectionStore {
	readonly kind: SelectionStoreKind;
	/** Every tag known for a branch. */
	tags(branch: readonly SessionEntry[]): TagIndex;
	/** Every judgement since the last compaction, by paragraph hash. */
	holds(branch: readonly SessionEntry[]): Map<string, number>;
	/** What tagging and judging have cost since the last compaction, in dollars. */
	spend(branch: readonly SessionEntry[]): number;
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
	return {
		kind: "memory",
		tags: () => index,
		holds: () => new Map(holds),
		spend: () => spent,
		recordTags(tags) {
			indexTags(index, tags);
			spent += tags.usage?.cost.total ?? 0;
		},
		recordHolds(recorded) {
			for (const [hash, value] of Object.entries(recorded.holds)) {
				holds.set(hash, value);
			}
			spent += recorded.usage?.cost.total ?? 0;
		},
		compacted() {
			holds = new Map();
			spent = 0;
		},
		reset() {
			index = emptyTagIndex();
			holds = new Map();
			spent = 0;
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

function costOf(data: unknown): number {
	if (typeof data !== "object" || data === null) return 0;
	const usage = (data as { usage?: { cost?: { total?: unknown } } }).usage;
	const total = usage?.cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}
