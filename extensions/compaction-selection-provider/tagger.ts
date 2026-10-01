/**
 * Tagging messages as the session goes: after each turn, every message
 * since the last compaction that has no tags yet is classified, one at
 * a time, and its tags recorded on the session.
 *
 * It runs in the background and never holds a turn up. One pass runs
 * at a time; a turn that ends during a pass asks for another once it
 * finishes, so a burst of turns costs one pass, not a queue of them.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { classify } from "../../lib/compaction/selection/classify.ts";
import {
	taggingRequest,
	tagsFrom,
} from "../../lib/compaction/selection/tagging.ts";
import {
	readTags,
	SELECTION_TAGS_ENTRY,
	type SelectionTags,
	untagged,
} from "../../lib/compaction/selection/tags.ts";
import {
	unitsOf,
	unitsOfBranch,
} from "../../lib/compaction/selection/units.ts";
import { resolveClassifier } from "./classifier.ts";

/** How many entries back the context for a message is read from. */
const CONTEXT_ENTRIES = 12;

/**
 * How many times a message is tried before it is recorded as failed
 * and left. A failure that cost something is recorded at once, so it
 * is billed and not paid for twice.
 */
const ATTEMPTS = 2;

/** Tags messages in the background. */
export interface Tagger {
	/** Tag whatever is untagged, now or once the pass under way ends. */
	schedule(ctx: ExtensionContext): void;
	/** Stop the pass under way and forget the session. */
	stop(): void;
	/** Resolves once no pass is running. */
	idle(): Promise<void>;
}

/** A tagger that records on the session through `pi.appendEntry`. */
export function tagger(pi: Pick<ExtensionAPI, "appendEntry">): Tagger {
	let controller = new AbortController();
	let latest: ExtensionContext | undefined;
	let running: Promise<void> | null = null;
	let again = false;
	let attempts = new Map<string, number>();

	const record = (tags: SelectionTags) =>
		pi.appendEntry(SELECTION_TAGS_ENTRY, tags);

	async function pass(ctx: ExtensionContext, signal: AbortSignal) {
		const classifier = await resolveClassifier(ctx);
		if (!classifier.ok || signal.aborted) return;
		const branch = ctx.sessionManager.getBranch();
		const position = new Map(branch.map((entry, at) => [entry.id, at]));
		for (const entry of untagged(branch, readTags(branch))) {
			if (signal.aborted) return;
			const tried = attempts.get(entry.id) ?? 0;
			if (tried >= ATTEMPTS) continue;
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
				record({
					entryId: entry.id,
					units: tagsFrom(units, result.answers),
					model: result.model,
					...(result.usage ? { usage: result.usage } : {}),
				});
				continue;
			}
			attempts.set(entry.id, tried + 1);
			const cost = result.usage?.cost.total ?? 0;
			if (cost > 0 || tried + 1 >= ATTEMPTS) {
				record({
					entryId: entry.id,
					units: [],
					model: classifier.label,
					...(result.usage ? { usage: result.usage } : {}),
					failed: result.reason,
				});
			}
		}
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
