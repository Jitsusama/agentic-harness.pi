/**
 * What the selection contributes to a compaction: the tagged paragraphs
 * it drops, quoted verbatim after the summary, within a budget.
 *
 * The host asks for contributions twice around a summary written
 * ahead: when it starts writing, and when the compaction applies it.
 * The first is when the still-applies check runs, in the background
 * alongside the summary, with its judgements recorded on the session.
 * The second is synchronous, so it quotes from what is recorded by
 * then: a candidate judged not to hold is left out, and one the check
 * never reached is quoted anyway. A compaction nobody wrote ahead gets
 * the second only.
 */

import {
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	findCutPoint,
} from "@earendil-works/pi-coding-agent";
import {
	isSummaryContributions,
	type SummaryContributions,
} from "../../lib/compaction/index.ts";
import { candidatesBefore } from "../../lib/compaction/selection/candidates.ts";
import { classify } from "../../lib/compaction/selection/classify.ts";
import {
	HOLDS_BATCH,
	holdsFrom,
	holdsRequests,
	readHolds,
	SELECTION_HOLDS_ENTRY,
	type SelectionHolds,
} from "../../lib/compaction/selection/holds.ts";
import { renderExcerpts } from "../../lib/compaction/selection/render.ts";
import { selectExcerpts } from "../../lib/compaction/selection/select.ts";
import { readTags } from "../../lib/compaction/selection/tags.ts";
import { unitsOfBranch } from "../../lib/compaction/selection/units.ts";
import { resolveClassifier } from "./classifier.ts";

/** The environment variable setting the excerpt budget in tokens; 0 turns it off. */
export const EXCERPT_TOKENS_ENV = "PI_COMPACTION_EXCERPT_TOKENS";

/** The excerpt budget when nothing sets one. */
export const DEFAULT_EXCERPT_TOKENS = 3000;

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

/** Contribute excerpts from the session `session` returns at the time. */
export function selectionContributor(
	pi: Pick<ExtensionAPI, "appendEntry">,
	session: () => ExtensionContext | undefined,
): SelectionContributor {
	let controller = new AbortController();
	let checking: Promise<void> | null = null;

	const excerpts = (
		contributions: SummaryContributions,
		ctx: ExtensionContext,
		firstKeptEntryId: string,
		budget: number,
	) => {
		const branch = ctx.sessionManager.getBranch();
		const candidates = candidatesBefore(
			branch,
			readTags(branch),
			firstKeptEntryId,
		);
		const text = renderExcerpts(
			selectExcerpts(candidates, budget, readHolds(branch)),
		);
		if (text) contributions.appendix.push(text);
	};

	const check = async (
		ctx: ExtensionContext,
		budget: number,
		signal: AbortSignal,
	) => {
		const classifier = await resolveClassifier(ctx);
		if (!classifier.ok || signal.aborted) return;
		const branch = ctx.sessionManager.getBranch();
		const holds = readHolds(branch);
		const pending = selectExcerpts(
			candidatesBefore(branch, readTags(branch), estimatedFirstKept(branch)),
			budget * CHECK_OVERSAMPLE,
			holds,
		).filter((candidate) => !holds.has(candidate.unit.hash));
		const requests = holdsRequests(pending, unitsOfBranch(branch));
		for (const [at, request] of requests.entries()) {
			if (signal.aborted) return;
			const chunk = pending.slice(at * HOLDS_BATCH, (at + 1) * HOLDS_BATCH);
			const result = await classify(classifier.classify, request, signal);
			if (signal.aborted) return;
			const recorded: SelectionHolds = result.ok
				? {
						holds: Object.fromEntries(holdsFrom(chunk, result.answers)),
						model: result.model,
						...(result.usage ? { usage: result.usage } : {}),
					}
				: {
						holds: {},
						model: classifier.label,
						...(result.usage ? { usage: result.usage } : {}),
						failed: result.reason,
					};
			if (result.ok || result.usage) {
				pi.appendEntry(SELECTION_HOLDS_ENTRY, recorded);
			}
		}
	};

	return {
		listener(data) {
			if (!isSummaryContributions(data)) return;
			const ctx = session();
			const budget = excerptTokens();
			if (!ctx || budget === 0) return;
			const firstKept = firstKeptOf(data.preparation);
			try {
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
