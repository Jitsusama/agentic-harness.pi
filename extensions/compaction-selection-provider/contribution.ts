/**
 * What the selection contributes to a compaction: the tagged paragraphs
 * it drops, quoted verbatim after the summary, within a budget.
 *
 * The host asks for contributions twice around a summary written
 * ahead: when it starts writing, and when the compaction applies it.
 * The first is when the still-applies check runs, in the background
 * alongside the summary, with its judgements recorded. Before it
 * judges, it lets the tagger catch up, so a backlog of untagged
 * messages is tagged in time to be quoted. The second is synchronous,
 * so it quotes from what is recorded by then: a candidate judged not
 * to hold is left out, and one the check never reached is quoted
 * anyway. A compaction nobody wrote ahead gets the second only.
 *
 * Each compaction is told what the selection did, through the host's
 * contribution records, whether it quoted anything or not: which
 * classifier it had or why it had none, the budget, how many
 * candidates there were and how many it chose, how many were judged
 * not to hold or never judged, how many messages it dropped untagged,
 * what tagging and judging cost since the last compaction, how long the
 * classifier took over them and how many tokens they used, and, when it
 * quoted nothing, why.
 */

import {
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionContext,
	findCutPoint,
} from "@earendil-works/pi-coding-agent";
import {
	isSummaryContributions,
	recordContribution,
	type SummaryContributions,
} from "../../lib/compaction/index.ts";
import { candidatesBefore } from "../../lib/compaction/selection/candidates.ts";
import { classify } from "../../lib/compaction/selection/classify.ts";
import {
	HOLDS_BATCH,
	holdsFrom,
	holdsRequests,
	type SelectionHolds,
} from "../../lib/compaction/selection/holds.ts";
import { renderExcerpts } from "../../lib/compaction/selection/render.ts";
import {
	HOLDS_THRESHOLD,
	selectExcerpts,
	whyNothingQuoted,
} from "../../lib/compaction/selection/select.ts";
import { untagged } from "../../lib/compaction/selection/tags.ts";
import {
	estimatedTokens,
	unitsOf,
	unitsOfBranch,
} from "../../lib/compaction/selection/units.ts";
import { type ClassifierStatus, classifierStatus } from "./classifier.ts";
import type { SelectionStore } from "./store.ts";

/** The environment variable setting the excerpt budget in tokens; 0 turns it off. */
export const EXCERPT_TOKENS_ENV = "PI_COMPACTION_EXCERPT_TOKENS";

/** The excerpt budget when nothing sets one. */
export const DEFAULT_EXCERPT_TOKENS = 3000;

/** The id the selection's record is kept under on a compaction. */
export const SELECTION_RECORD_ID = "selection";

/**
 * How many times the budget the check looks at. Some candidates will
 * be judged not to hold, and the ones behind them should have been
 * judged too by the time they are needed.
 */
const CHECK_OVERSAMPLE = 2;

/** The excerpt budget the environment sets. */
export function excerptTokens(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[EXCERPT_TOKENS_ENV]?.trim();
	if (!raw) return DEFAULT_EXCERPT_TOKENS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0
		? Math.floor(parsed)
		: DEFAULT_EXCERPT_TOKENS;
}

/** The contribution listener, and a way to stop its background check. */
export interface SelectionContributor {
	/** Listens on the summary contributions channel. */
	listener(data: unknown): void;
	stop(): void;
	/** Resolves once no check is running. */
	idle(): Promise<void>;
}

/** What the contributor reads and records through. */
export interface ContributorOptions {
	readonly store: SelectionStore;
	/** Shared with the tagger, so both report the same classifier. */
	readonly status?: ClassifierStatus;
	/** Whether to name each quote's paragraph, for a recall tool. */
	readonly refs?: () => boolean;
	/** Let the tagger finish what it has, before the check judges. */
	readonly caughtUp?: (ctx: ExtensionContext) => Promise<void>;
}

/** Contribute excerpts from the session `session` returns at the time. */
export function selectionContributor(
	session: () => ExtensionContext | undefined,
	options: ContributorOptions,
): SelectionContributor {
	const { store } = options;
	const status = options.status ?? classifierStatus();
	let controller = new AbortController();
	let checking: Promise<void> | null = null;

	const excerpts = (
		contributions: SummaryContributions,
		ctx: ExtensionContext,
		firstKeptEntryId: string,
		budget: number,
	) => {
		const branch = ctx.sessionManager.getBranch();
		const tags = store.tags(branch);
		const holds = store.holds(branch);
		const candidates = candidatesBefore(branch, tags, firstKeptEntryId);
		const chosen = selectExcerpts(candidates, budget, holds);
		const refs = options.refs?.() ?? false;
		const text = renderExcerpts(chosen, { refs });
		if (text) contributions.appendix.push(text);
		const dropped = new Set(droppedIds(branch, firstKeptEntryId));
		const waiting = new Set(untagged(branch, tags).map((e) => e.id));
		const droppedWithText = sinceLastCompaction(branch).filter(
			(e) => dropped.has(e.id) && unitsOf(e).length > 0,
		);
		const untaggedDropped = droppedWithText.filter((e) =>
			waiting.has(e.id),
		).length;
		const taggedDropped = droppedWithText.length - untaggedDropped;
		recordContribution(contributions, SELECTION_RECORD_ID, {
			...status.current(),
			store: store.kind,
			budget,
			candidates: candidates.length,
			chosen: chosen.length,
			excerptTokens: chosen.reduce(
				(sum, c) => sum + estimatedTokens(c.unit.text),
				0,
			),
			notHolding: candidates.filter(
				(c) => (holds.get(c.unit.hash) ?? 1) < HOLDS_THRESHOLD,
			).length,
			unchecked: chosen.filter((c) => !holds.has(c.unit.hash)).length,
			untagged: untaggedDropped,
			refs,
			spend: store.spend(branch),
			...store.effort(branch),
			...(chosen.length === 0
				? {
						nothingQuoted: whyNothingQuoted({
							candidates,
							holds,
							taggedDropped,
							untaggedDropped,
						}),
					}
				: {}),
		});
	};

	const check = async (
		ctx: ExtensionContext,
		budget: number,
		signal: AbortSignal,
	) => {
		await options.caughtUp?.(ctx);
		if (signal.aborted) return;
		const classifier = await status.resolve(ctx);
		if (!classifier.ok || signal.aborted) return;
		const branch = ctx.sessionManager.getBranch();
		const holds = store.holds(branch);
		const pending = selectExcerpts(
			candidatesBefore(branch, store.tags(branch), estimatedFirstKept(branch)),
			budget * CHECK_OVERSAMPLE,
			holds,
		).filter((candidate) => !holds.has(candidate.unit.hash));
		const requests = holdsRequests(pending, unitsOfBranch(branch));
		for (const [at, request] of requests.entries()) {
			if (signal.aborted) return;
			const chunk = pending.slice(at * HOLDS_BATCH, (at + 1) * HOLDS_BATCH);
			const started = Date.now();
			const result = await classify(classifier.classify, request, signal);
			const ms = Date.now() - started;
			if (signal.aborted) return;
			const recorded: SelectionHolds = result.ok
				? {
						holds: Object.fromEntries(holdsFrom(chunk, result.answers)),
						model: result.model,
						...(result.usage ? { usage: result.usage } : {}),
						ms,
					}
				: {
						holds: {},
						model: classifier.label,
						...(result.usage ? { usage: result.usage } : {}),
						ms,
						failed: result.reason,
					};
			if (result.ok || result.usage) store.recordHolds(recorded);
		}
	};

	return {
		listener(data) {
			if (!isSummaryContributions(data)) return;
			const ctx = session();
			if (!ctx) return;
			const budget = excerptTokens();
			const firstKept = data.firstKeptEntryId ?? firstKeptOf(data.preparation);
			try {
				if (budget === 0) {
					if (firstKept) {
						recordContribution(data, SELECTION_RECORD_ID, {
							budget,
							nothingQuoted: "off",
						});
					}
					return;
				}
				if (firstKept) {
					excerpts(data, ctx, firstKept, budget);
					return;
				}
				if (checking) return;
				const signal = controller.signal;
				const mine: Promise<void> = check(ctx, budget, signal)
					.catch(() => {
						// The check is a refinement: a failure leaves its
						// candidates unjudged, and they are quoted anyway.
					})
					.finally(() => {
						if (checking === mine) checking = null;
					});
				checking = mine;
			} catch {
				// A contributor must never cost the compaction its summary;
				// without excerpts the summary is what pi would have had.
			}
		},
		stop() {
			controller.abort();
			controller = new AbortController();
			checking = null;
		},
		async idle() {
			while (checking) await checking;
		},
	};
}

/** The entries after the branch's last compaction, which `untagged` reads. */
function sinceLastCompaction(
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
): typeof branch {
	let start = 0;
	branch.forEach((entry, at) => {
		if (entry.type === "compaction") start = at + 1;
	});
	return branch.slice(start);
}

/** The ids of the entries a compaction keeping from `firstKeptEntryId` drops. */
function droppedIds(
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
	firstKeptEntryId: string,
): string[] {
	const at = branch.findIndex((entry) => entry.id === firstKeptEntryId);
	return branch.slice(0, at < 0 ? branch.length : at).map((entry) => entry.id);
}

/**
 * Where pi would start keeping the conversation verbatim if it
 * compacted now, which is what a summary written ahead is applied
 * against unless the session has moved far on by then.
 */
function estimatedFirstKept(
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
): string | undefined {
	const cut = findCutPoint(
		[...branch],
		0,
		branch.length,
		DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
	);
	return branch[cut.firstKeptEntryIndex]?.id;
}

/** The first kept entry of a real compaction's preparation, if this is one. */
function firstKeptOf(preparation: object): string | undefined {
	if (!("firstKeptEntryId" in preparation)) return undefined;
	const id = preparation.firstKeptEntryId;
	return typeof id === "string" ? id : undefined;
}
