/**
 * Tagging messages as the session goes: after each turn, every message
 * since the last compaction with a paragraph nothing is known of is
 * classified, and its tags recorded.
 *
 * It runs in the background and never holds a turn up. One pass runs
 * at a time; a turn that ends during a pass asks for another once it
 * finishes, so a burst of turns costs one pass, not a queue of them.
 * Within a pass a few messages are asked at once, newest first: a
 * session that arrives with a backlog (a resumed one, or one whose
 * host lost the tags) gets its recent messages tagged first, which are
 * the ones a compaction soon to come will drop last and quote most.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify } from "../../lib/compaction/selection/classify.ts";
import {
	taggingRequest,
	tagsFrom,
} from "../../lib/compaction/selection/tagging.ts";
import {
	taggedBranchAt,
	untagged,
} from "../../lib/compaction/selection/tags.ts";
import {
	unitsOf,
	unitsOfBranch,
} from "../../lib/compaction/selection/units.ts";
import {
	type BranchReader,
	entriesBefore,
	type LinkedEntry,
} from "../../lib/internal/session/branch-walk.ts";
import { type ClassifierStatus, classifierStatus } from "./classifier.ts";
import type { SelectionStore } from "./store.ts";

/** How many entries back the context for a message is read from. */
const CONTEXT_ENTRIES = 12;

/**
 * How many times a message is tried before it is recorded as failed
 * and left. A failure that cost something is recorded at once, so it
 * is billed and not paid for twice.
 */
const ATTEMPTS = 2;

/** How many messages are asked about at once. */
export const TAGGING_CONCURRENCY = 4;

/** Tags messages in the background. */
export interface Tagger {
	/** Tag whatever is untagged, now or once the pass under way ends. */
	schedule(ctx: ExtensionContext): void;
	/** Stop the pass under way and forget the session. */
	stop(): void;
	/** Resolves once no pass is running. */
	idle(): Promise<void>;
}

/** A tagger that records into `store`, asking the classifier `status` resolves. */
export function tagger(
	store: SelectionStore,
	status: ClassifierStatus = classifierStatus(),
): Tagger {
	let controller = new AbortController();
	let latest: ExtensionContext | undefined;
	let running: Promise<void> | null = null;
	let again = false;
	let attempts = new Map<string, number>();

	async function pass(ctx: ExtensionContext, signal: AbortSignal) {
		const classifier = await status.resolve(ctx);
		if (!classifier.ok || signal.aborted) return;
		// Read from what the branch gained since the last pass, not the
		// whole branch, since a pass follows every turn.
		const session = ctx.sessionManager;
		// Every message queued lies behind this leaf.
		const under = { leaf: session.getLeafId() };
		const { live } = taggedBranchAt(session);
		const queue = untagged(live, store.tagsAt(session))
			.filter((entry) => (attempts.get(entry.id) ?? 0) < ATTEMPTS)
			.reverse();

		const tagOne = async (entry: (typeof queue)[number]) => {
			const tried = attempts.get(entry.id) ?? 0;
			const units = unitsOf(entry);
			const before = unitsOfBranch(
				entriesBefore(session, entry, CONTEXT_ENTRIES),
			);
			const started = Date.now();
			const result = await classify(
				classifier.classify,
				taggingRequest(units, before),
				signal,
			);
			const ms = Date.now() - started;
			if (signal.aborted) return;
			// A tag lands wherever the branch is now, so a message the person
			// moved away from while it was asked about is left untagged: its
			// tag would name, from this branch, a message only the log holds.
			// What the call cost is still recorded, naming no paragraph, and
			// the pass ends, for a fresh one to tag the branch as it is now.
			if (!stillHolds(session, under, entry.id)) {
				queue.length = 0;
				again = true;
				if (result.usage) {
					store.recordTags({
						entryId: entry.id,
						units: [],
						model: result.ok ? result.model : classifier.label,
						usage: result.usage,
						ms,
						failed: MOVED_OFF,
					});
				}
				return;
			}
			if (result.ok) {
				store.recordTags({
					entryId: entry.id,
					units: tagsFrom(units, result.answers),
					model: result.model,
					...(result.usage ? { usage: result.usage } : {}),
					ms,
					seenOnBranch: true,
				});
				return;
			}
			attempts.set(entry.id, tried + 1);
			const cost = result.usage?.cost.total ?? 0;
			if (cost > 0 || tried + 1 >= ATTEMPTS) {
				store.recordTags({
					entryId: entry.id,
					units: units.map((unit) => ({ hash: unit.hash, kinds: [] })),
					model: classifier.label,
					...(result.usage ? { usage: result.usage } : {}),
					ms,
					failed: result.reason,
				});
			}
		};

		const worker = async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				if (signal.aborted) return;
				await tagOne(next);
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(TAGGING_CONCURRENCY, queue.length) },
				worker,
			),
		);
	}

	function start() {
		const signal = controller.signal;
		const mine: Promise<void> = (async () => {
			do {
				again = false;
				const ctx = latest;
				if (!ctx || signal.aborted) break;
				try {
					await pass(ctx, signal);
				} catch {
					// A pass that throws is a session that moved under it,
					// or a registry that did; the next turn tries again,
					// and nothing is recorded for work that did not happen.
				}
			} while (again && !signal.aborted);
		})().finally(() => {
			if (running === mine) running = null;
		});
		running = mine;
	}

	return {
		schedule(ctx) {
			latest = ctx;
			if (running) {
				again = true;
				return;
			}
			start();
		},
		stop() {
			controller.abort();
			controller = new AbortController();
			// The stopped pass winds down on its own; a new session must
			// not wait behind it.
			running = null;
			latest = undefined;
			again = false;
			attempts = new Map();
		},
		async idle() {
			while (running) await running;
		},
	};
}

/** Why a paid answer was recorded with no paragraph: its message left the branch. */
const MOVED_OFF = "moved off the branch";

/**
 * Whether the session's branch now still holds entry `id`, which lay
 * behind `under.leaf`. The walk back from the leaf stops at `id` or at
 * `under.leaf`, so a conversation that only went on reads just what it
 * gained, and `under.leaf` moves up to the leaf now for the next check.
 * Only a branch elsewhere is walked to its root.
 */
function stillHolds(
	session: BranchReader<LinkedEntry>,
	under: { leaf: string | null | undefined },
	id: string,
): boolean {
	const leaf = session.getLeafId();
	for (let at = leaf; at; at = session.getEntry(at)?.parentId) {
		if (at === id) return true;
		if (at !== under.leaf) continue;
		under.leaf = leaf;
		return true;
	}
	return false;
}
