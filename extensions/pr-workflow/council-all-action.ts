/**
 * Multi-PR council fan-out.
 *
 * Phase 4 testing showed that per-PR pipelines don't
 * scale: a 4-PR stack with 5 reviewers each takes ~1
 * hour run sequentially. The user has to babysit every
 * call.
 *
 * `runCouncilAllAction` is Phase A of the
 * stack-wide-context redesign (see
 * `pr-mode-redesign/designs/20-stack-wide-context-review.md`).
 * It fans the existing per-PR council out across the
 * loaded stack concurrently. No prompt changes, no
 * schema changes — just a concurrency primitive on top
 * of `runCouncil`.
 *
 * The cursor PR's result lands in `state.council.lastRun`
 * (so the existing single-PR pipeline — `judge`,
 * `findings`, `decide`, `post` — keeps working
 * unchanged). The non-cursor PRs land in
 * `state.stackRuns` so `stack-next` / `stack-prev` pulls
 * them into `council.lastRun` when the user navigates.
 *
 * Metadata and diff fetches are also parallelised: the
 * cursor PR's payloads stay in `state.pr`, and each
 * other stack entry gets fetched via injected helpers
 * (test path stays pure).
 */

import type { DiffFile } from "../../lib/internal/github/diff.js";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { CouncilDispatch } from "./council.js";
import { runCouncil } from "./council.js";
import type { PrMetadata } from "./fetch.js";
import type { CouncilRun } from "./findings.js";
import type {
	PrRunSnapshot,
	PrWorkflowState,
	ThreadsSnapshot,
} from "./state.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Per-PR outcome inside a council-all run. */
export interface CouncilAllEntry {
	readonly prNumber: number;
	readonly run: CouncilRun | null;
	readonly error: string | null;
}

/** Full result returned by `runCouncilAllAction`. */
export interface CouncilAllRun {
	readonly id: string;
	readonly startedAt: string;
	readonly cursorPrNumber: number;
	readonly entries: readonly CouncilAllEntry[];
}

/** Helpers needed to fetch missing per-PR context. */
export interface CouncilAllFetchers {
	readonly metadata: (reference: PRReference) => Promise<PrMetadata>;
	readonly diff: (reference: PRReference) => Promise<DiffFile[]>;
}

/** Inputs for `runCouncilAllAction`. */
export interface RunCouncilAllActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	readonly fetchers: CouncilAllFetchers;
	/** Override clock for tests; production uses `Date.now()`. */
	readonly now?: () => Date;
}

/** Outcome of the action wrapper. */
export type CouncilAllActionResult =
	| { ok: true; run: CouncilAllRun }
	| { ok: false; error: string };

/**
 * Run the configured council against every PR in the
 * loaded stack concurrently.
 *
 * Refuses to run when there's no stack to fan across,
 * no roster, or no judge configured — same guard rails
 * as the single-PR `runCouncilAction`, so the user
 * doesn't strand themselves at a dead-end.
 */
export async function runCouncilAllAction(
	input: RunCouncilAllActionInput,
): Promise<CouncilAllActionResult> {
	const { state } = input;
	if (state.pr === null) {
		return {
			ok: false,
			error: "No PR is loaded. Call pr_workflow action=load first.",
		};
	}
	if (state.council.roster.length === 0) {
		return {
			ok: false,
			error:
				"Council roster is empty. Call pr_workflow action=council-config first.",
		};
	}
	if (state.council.judge === null) {
		return {
			ok: false,
			error:
				"Judge not configured. Call pr_workflow action=judge-config " +
				"before running council-all so downstream actions stay reachable.",
		};
	}
	const stack = state.pr.stack;
	if (stack === null || stack.entries.length <= 1) {
		return {
			ok: false,
			error:
				"council-all requires a multi-PR stack. The loaded PR has no " +
				"stack-mates; call action=council for a single-PR review.",
		};
	}

	// Collect (reference, metadata, diff) for every PR.
	// The cursor PR already has metadata + files; others
	// fetch concurrently via the injected helpers.
	type Resolved = {
		readonly reference: PRReference;
		readonly title: string;
		readonly headSha: string;
		readonly files: readonly DiffFile[];
	};

	const cursorPrNumber = state.pr.reference.number;
	const cursorMetadata = state.pr.metadata;
	if (cursorMetadata === null) {
		return {
			ok: false,
			error:
				"PR metadata is missing for the cursor PR. Reload before " +
				"running council-all.",
		};
	}

	const entries = stack.entries;
	const resolvedSettled = await Promise.allSettled(
		entries.map(async (entry): Promise<Resolved> => {
			if (entry.reference.number === cursorPrNumber) {
				return {
					reference: entry.reference,
					title: cursorMetadata.title,
					headSha: cursorMetadata.head.sha,
					files: state.pr?.files ?? [],
				};
			}
			const [metadata, files] = await Promise.all([
				input.fetchers.metadata(entry.reference),
				input.fetchers.diff(entry.reference),
			]);
			return {
				reference: entry.reference,
				title: metadata.title,
				headSha: metadata.head.sha,
				files,
			};
		}),
	);

	const now = input.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const runId = `council-all-${startedAt}`;

	// Dispatch the council for each PR whose context
	// resolved. Failed fetches surface as per-PR errors
	// in the returned entries — the user can retry one
	// without re-running the whole batch.
	const dispatched = await Promise.allSettled(
		resolvedSettled.map(async (resolveResult, index) => {
			const entry = entries[index];
			if (resolveResult.status === "rejected") {
				const message =
					resolveResult.reason instanceof Error
						? resolveResult.reason.message
						: String(resolveResult.reason);
				return {
					prNumber: entry.reference.number,
					run: null,
					error: `Could not fetch PR context: ${message}`,
				} satisfies CouncilAllEntry;
			}
			const resolved = resolveResult.value;
			const run = await runCouncil({
				runId: `${runId}-pr-${entry.reference.number}`,
				target: {
					owner: resolved.reference.owner,
					repo: resolved.reference.repo,
					sha: resolved.headSha,
					prNumber: resolved.reference.number,
					title: resolved.title,
					description: "",
					files: [...resolved.files],
				},
				reviewers: state.council.roster,
				registry: input.registry,
				dispatch: input.dispatch,
				signal: input.signal,
			});
			return {
				prNumber: entry.reference.number,
				run,
				error: null,
			} satisfies CouncilAllEntry;
		}),
	);

	const outcome: CouncilAllEntry[] = dispatched.map((result, index) => {
		const entry = entries[index];
		if (result.status === "rejected") {
			const message =
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
			return {
				prNumber: entry.reference.number,
				run: null,
				error: `Council dispatch threw: ${message}`,
			} satisfies CouncilAllEntry;
		}
		return result.value;
	});

	// Push each successful run into the right slot:
	// cursor PR → state.council.lastRun (so the
	// existing pipeline picks it up); others →
	// state.stackRuns so loadPr can rehydrate them on
	// navigation.
	for (const entry of outcome) {
		if (entry.run === null) continue;
		if (entry.prNumber === cursorPrNumber) {
			state.council.lastRun = entry.run;
			continue;
		}
		state.stackRuns.set(
			entry.prNumber,
			mergeRunIntoSnapshot(state.stackRuns.get(entry.prNumber), entry.run),
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

/**
 * Merge a fresh `CouncilRun` into the optional prior
 * snapshot for a stack mate. The judge / critique /
 * decision fields are preserved from the prior snapshot
 * when present — the user may have iterated on the PR
 * already and we don't want to forget their work.
 */
function mergeRunIntoSnapshot(
	prior: PrRunSnapshot | undefined,
	run: CouncilRun,
): PrRunSnapshot {
	if (!prior) {
		return {
			lastRun: run,
			lastJudge: null,
			lastCritique: null,
			decisions: new Map(),
		};
	}
	return {
		lastRun: run,
		lastJudge: prior.lastJudge,
		lastCritique: prior.lastCritique,
		decisions: prior.decisions,
	};
}

/** Render a `CouncilAllRun` for the tool's text output. */
export function formatCouncilAllSummary(run: CouncilAllRun): string {
	const lines: string[] = [];
	const ran = run.entries.filter((e) => e.run !== null).length;
	const failed = run.entries.length - ran;
	const noun = run.entries.length === 1 ? "PR" : "PRs";
	lines.push(
		`Council-all ${run.id} on ${run.entries.length} ${noun} (cursor #${run.cursorPrNumber})`,
	);
	lines.push(`Started: ${run.startedAt}`);
	lines.push(
		`Result: ${ran} council${ran === 1 ? "" : "s"} completed${failed > 0 ? `, ${failed} failed` : ""}`,
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
		const totalFindings = entry.run.reviewerOutputs.reduce(
			(sum, output) => sum + output.findings.length,
			0,
		);
		const f = totalFindings === 1 ? "finding" : "findings";
		lines.push(
			`${marker} PR #${entry.prNumber}: ${totalFindings} ${f} from ${entry.run.reviewerOutputs.length} reviewers`,
		);
	}
	lines.push("");
	lines.push(
		"Cursor PR is live as state.council.lastRun. Run action=judge to consolidate.",
	);
	lines.push(
		"Stack mates are stashed; action=stack-next / action=stack-prev pulls their run into the cursor slot.",
	);
	return lines.join("\n");
}

// Re-export so the action handler can name the threads
// snapshot type without re-importing from state.js (keeps
// the index.ts shape tidy).
export type { ThreadsSnapshot };
