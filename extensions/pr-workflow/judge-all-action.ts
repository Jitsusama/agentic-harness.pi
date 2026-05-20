/**
 * Multi-PR judge fan-out.
 *
 * `council-all` fills each stack PR's round-1 slot. This
 * action consumes those per-PR council runs and executes
 * the existing round-2 judge for every available run.
 *
 * The storage contract mirrors `council-all`: the cursor
 * PR's judge result lands in `state.council.lastJudge`,
 * while stack mates land in `state.stackRuns` so normal
 * stack navigation rehydrates the right per-PR state.
 */

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { CouncilDispatch } from "./council.js";
import type { PrMetadata } from "./fetch.js";
import type { CouncilRun } from "./findings.js";
import { type JudgeRun, runJudge } from "./judge.js";
import type { PrRunSnapshot, PrWorkflowState } from "./state.js";
import type { FindingDecision } from "./synthesis.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Per-PR outcome inside a judge-all run. */
export interface JudgeAllEntry {
	readonly prNumber: number;
	readonly run: JudgeRun | null;
	readonly error: string | null;
}

/** Full result returned by `runJudgeAllAction`. */
export interface JudgeAllRun {
	readonly id: string;
	readonly startedAt: string;
	readonly cursorPrNumber: number;
	readonly entries: readonly JudgeAllEntry[];
}

/** Helpers needed to fetch missing per-PR target metadata. */
export interface JudgeAllFetchers {
	readonly metadata: (reference: PRReference) => Promise<PrMetadata>;
}

/** Inputs for `runJudgeAllAction`. */
export interface RunJudgeAllActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	readonly fetchers: JudgeAllFetchers;
	/** Override clock for tests; production uses `Date.now()`. */
	readonly now?: () => Date;
}

/** Outcome of the action wrapper. */
export type JudgeAllActionResult =
	| { ok: true; run: JudgeAllRun }
	| { ok: false; error: string };

/** Run the judge against every stack PR with a council run. */
export async function runJudgeAllAction(
	input: RunJudgeAllActionInput,
): Promise<JudgeAllActionResult> {
	const { state } = input;
	if (state.pr === null) {
		return {
			ok: false,
			error: "No PR is loaded. Call pr_workflow action=load first.",
		};
	}
	if (state.council.judge === null) {
		return {
			ok: false,
			error:
				"Judge not configured. Call pr_workflow action=judge-config first.",
		};
	}
	const stack = state.pr.stack;
	if (stack === null || stack.entries.length <= 1) {
		return {
			ok: false,
			error:
				"judge-all requires a multi-PR stack. The loaded PR has no " +
				"stack-mates; call action=judge for a single-PR review.",
		};
	}
	if (state.pr.metadata === null) {
		return {
			ok: false,
			error:
				"PR metadata is missing for the cursor PR. Reload before " +
				"running judge-all.",
		};
	}

	const judge = state.council.judge;
	const now = input.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const runId = `judge-all-${startedAt}`;
	const cursorPrNumber = state.pr.reference.number;
	const cursorMetadata = state.pr.metadata;
	const entries = stack.entries;

	type JudgeTarget = {
		readonly reference: PRReference;
		readonly council: CouncilRun | null;
		readonly sha: string | null;
		readonly error: string | null;
	};

	const targets = await Promise.allSettled(
		entries.map(async (entry): Promise<JudgeTarget> => {
			const council = councilRunForPr(state, entry.reference.number);
			if (council === null) {
				return {
					reference: entry.reference,
					council: null,
					sha: null,
					error:
						"No council run available. Run action=council-all first or " +
						"navigate to this PR and run action=council.",
				};
			}
			if (entry.reference.number === cursorPrNumber) {
				return {
					reference: entry.reference,
					council,
					sha: cursorMetadata.head.sha,
					error: null,
				};
			}
			const metadata = await input.fetchers.metadata(entry.reference);
			return {
				reference: entry.reference,
				council,
				sha: metadata.head.sha,
				error: null,
			};
		}),
	);

	const judged = await Promise.allSettled(
		targets.map(async (targetResult, index) => {
			const entry = entries[index];
			if (targetResult.status === "rejected") {
				return {
					prNumber: entry.reference.number,
					run: null,
					error: `Could not fetch PR metadata: ${errorMessage(targetResult.reason)}`,
				} satisfies JudgeAllEntry;
			}
			const target = targetResult.value;
			if (
				target.error !== null ||
				target.council === null ||
				target.sha === null
			) {
				return {
					prNumber: entry.reference.number,
					run: null,
					error: target.error ?? "No judge target available.",
				} satisfies JudgeAllEntry;
			}
			const run = await runJudge({
				runId: `${runId}-pr-${entry.reference.number}`,
				council: target.council,
				judge,
				target: {
					owner: target.reference.owner,
					repo: target.reference.repo,
					sha: target.sha,
				},
				registry: input.registry,
				dispatch: input.dispatch,
				signal: input.signal,
			});
			return {
				prNumber: entry.reference.number,
				run,
				error: null,
			} satisfies JudgeAllEntry;
		}),
	);

	const outcome = judged.map((result, index): JudgeAllEntry => {
		const entry = entries[index];
		if (result.status === "rejected") {
			return {
				prNumber: entry.reference.number,
				run: null,
				error: `Judge dispatch threw: ${errorMessage(result.reason)}`,
			};
		}
		return result.value;
	});

	for (const entry of outcome) {
		if (entry.run === null) continue;
		if (entry.prNumber === cursorPrNumber) {
			state.council.lastJudge = entry.run;
			continue;
		}
		const prior = state.stackRuns.get(entry.prNumber);
		state.stackRuns.set(
			entry.prNumber,
			mergeJudgeIntoSnapshot(prior, entry.run),
		);
	}

	return {
		ok: true,
		run: {
			id: runId,
			startedAt,
			cursorPrNumber,
			entries: outcome,
		},
	};
}

function councilRunForPr(
	state: PrWorkflowState,
	prNumber: number,
): CouncilRun | null {
	if (state.pr?.reference.number === prNumber) {
		return state.council.lastRun;
	}
	return state.stackRuns.get(prNumber)?.lastRun ?? null;
}

function mergeJudgeIntoSnapshot(
	prior: PrRunSnapshot | undefined,
	run: JudgeRun,
): PrRunSnapshot {
	const decisions = prior?.decisions ?? new Map<number, FindingDecision>();
	return {
		lastRun: prior?.lastRun ?? null,
		lastJudge: run,
		lastCritique: prior?.lastCritique ?? null,
		decisions,
	};
}

/** Render a `JudgeAllRun` for the tool's text output. */
export function formatJudgeAllSummary(run: JudgeAllRun): string {
	const lines: string[] = [];
	const judged = run.entries.filter((e) => e.run !== null).length;
	const failed = run.entries.length - judged;
	const noun = run.entries.length === 1 ? "PR" : "PRs";
	lines.push(
		`Judge-all ${run.id} on ${run.entries.length} ${noun} (cursor #${run.cursorPrNumber})`,
	);
	lines.push(`Started: ${run.startedAt}`);
	lines.push(
		`Result: ${judged} judge${judged === 1 ? "" : "s"} completed${failed > 0 ? `, ${failed} failed` : ""}`,
	);
	for (const entry of run.entries) {
		lines.push("");
		const marker = entry.prNumber === run.cursorPrNumber ? "▶" : " ";
		if (entry.run === null) {
			lines.push(
				`${marker} PR #${entry.prNumber}: ${entry.error ?? "no result"}`,
			);
			continue;
		}
		const count = entry.run.consolidatedFindings.length;
		const f = count === 1 ? "finding" : "findings";
		lines.push(`${marker} PR #${entry.prNumber}: ${count} consolidated ${f}`);
	}
	lines.push("");
	lines.push(
		"Cursor PR is live as state.council.lastJudge. Run action=findings to review it.",
	);
	lines.push(
		"Stack mates are stashed; action=stack-next / action=stack-prev pulls their judge run into the cursor slot.",
	);
	return lines.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
