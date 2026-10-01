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
import { untagged } from "../../lib/compaction/selection/tags.ts";
import {
	unitsOf,
	unitsOfBranch,
} from "../../lib/compaction/selection/units.ts";
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
		const branch = ctx.sessionManager.getBranch();
		const position = new Map(branch.map((entry, at) => [entry.id, at]));
		const queue = untagged(branch, store.tags(branch))
			.filter((entry) => (attempts.get(entry.id) ?? 0) < ATTEMPTS)
			.reverse();

		const tagOne = async (entry: (typeof queue)[number]) => {
			const tried = attempts.get(entry.id) ?? 0;
			const at = position.get(entry.id) ?? 0;
			const units = unitsOf(entry);
			const before = unitsOfBranch(
				branch.slice(Math.max(0, at - CONTEXT_ENTRIES), at),
			);
			const result = await classify(
				classifier.classify,
				taggingRequest(units, before),
				signal,
			);
			if (signal.aborted) return;
			if (result.ok) {
				store.recordTags({
					entryId: entry.id,
					units: tagsFrom(units, result.answers),
					model: result.model,
					...(result.usage ? { usage: result.usage } : {}),
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
