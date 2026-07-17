/**
 * Action handlers for `judge-config` and `judge` tool
 * actions.
 *
 * Mirrors the shape of `council-action.ts`: pure
 * functions over `PrWorkflowState` with the dispatch
 * boundary injected so unit tests don't spawn pi.
 */

import type { CouncilReviewer } from "../../lib/subagent/subagent.js";
import { isReviewerCancelledError } from "./cancellation.js";
import type { CouncilDispatch } from "./council.js";
import type { CouncilProgress } from "./council-progress.js";
import { reserveFindingIds } from "./finding-ids.js";
import { type JudgePersonaExhibit, type JudgeRun, runJudge } from "./judge.js";
import {
	assertParticipantIdentityAvailable,
	rememberParticipantIdentity,
} from "./participant-identities.js";
import type { ReviewContextProviderBroker } from "./review-context.js";
import { reviewerFailureBanner } from "./reviewer-outcome.js";
import { composeRunAddendum } from "./run-intent.js";
import type { PrWorkflowState } from "./state.js";
import { stackReviewOverwriteNote } from "./synthesis.js";
import {
	loadReviewThreadPromptContext,
	type ReviewThreadsFetcher,
} from "./thread-context.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Result of a state-mutating action. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Inputs for `configureJudge`. */
export interface ConfigureJudgeInput {
	readonly judge: CouncilReviewer;
}

/** Set the judge reviewer for the next round-2 run. */
export function configureJudge(
	state: PrWorkflowState,
	input: ConfigureJudgeInput,
): ActionResult {
	if (input.judge.id.trim() === "") {
		return {
			ok: false,
			error: "Judge id is empty: every finding needs a stamping reviewer id.",
		};
	}
	if (state.council.roster.some((r) => r.id === input.judge.id)) {
		return {
			ok: false,
			error: `Judge id "${input.judge.id}" is already used by a council reviewer. Council reviewer ids and judge id must be distinct within a session.`,
		};
	}
	const identity = assertParticipantIdentityAvailable(
		state,
		"judge",
		input.judge,
	);
	if (!identity.ok) return identity;
	state.council.judge = { ...input.judge };
	return { ok: true };
}

/** Inputs for `runJudgeAction`. */
export interface RunJudgeActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly reviewContexts?: ReviewContextProviderBroker;
	readonly fetchThreads?: ReviewThreadsFetcher;
	readonly progress?: CouncilProgress;
	readonly signal?: AbortSignal;
	readonly now?: () => Date;
	/**
	 * The judge's standing charter (its law), forwarded to the
	 * judge subagent as its system prompt. The tool layer resolves
	 * it from `judge.md` or the built-in default.
	 */
	readonly judgeCharter?: string;
	/**
	 * The user's per-run intent for this judge run (e.g. "be
	 * stricter", "the migration is the risky part"), merged into
	 * the prompt addendum. The judge's law lives in its charter;
	 * this is the per-run knob.
	 */
	readonly intent?: string;
	/**
	 * The personas the council reviewers wore, as exhibits for the
	 * judge (who said what, through which lens). The tool builds
	 * this from the roster and the persona library; the judge weighs
	 * them but never adopts one.
	 */
	readonly personaExhibits?: readonly JudgePersonaExhibit[];
}

/** Result of running the judge. */
export type JudgeActionResult =
	| { ok: true; run: JudgeRun; warnings?: readonly string[] }
	| { ok: false; error: string };

/**
 * Run the judge round against the most recent council
 * run. Stores the resulting `JudgeRun` in
 * `state.council.lastJudge` on success.
 */
export async function runJudgeAction(
	input: RunJudgeActionInput,
): Promise<JudgeActionResult> {
	const { state } = input;
	if (state.council.lastRun === null) {
		return {
			ok: false,
			error: "No council run available. Call pr_workflow action=council first.",
		};
	}
	if (state.council.judge === null) {
		return {
			ok: false,
			error:
				"Judge not configured. Call pr_workflow action=judge-config first.",
		};
	}
	if (state.pr === null || state.pr.metadata === null) {
		return {
			ok: false,
			error: "PR is not fully loaded; reload before judging.",
		};
	}

	const now = input.now ?? (() => new Date());
	const runId = `judge-${now().toISOString()}`;
	// Pin to the PR this judge run started on; a concurrent
	// action=load must not redirect where the run lands.
	const pinnedPrNumber = state.pr.reference.number;
	const target = {
		owner: state.pr.reference.owner,
		repo: state.pr.reference.repo,
		sha: state.pr.metadata.head.sha,
		branch: state.pr.metadata.head.ref,
	};
	const [providerAddendum, threadContext] = await Promise.all([
		input.reviewContexts?.promptAddendum({
			...target,
			prNumber: state.pr.reference.number,
			stage: "judge",
		}),
		loadReviewThreadPromptContext(state, input.fetchThreads),
	]);
	const promptAddendum = composeRunAddendum(providerAddendum, input.intent);
	let run: JudgeRun;
	try {
		run = await runJudge({
			runId,
			council: state.council.lastRun,
			judge: state.council.judge,
			target,
			registry: input.registry,
			dispatch: input.dispatch,
			threadContext,
			progress: input.progress,
			signal: input.signal,
			allocate: (count) => reserveFindingIds(state, count),
			...(promptAddendum ? { promptAddendum } : {}),
			...(input.judgeCharter ? { charter: input.judgeCharter } : {}),
			...(input.personaExhibits && input.personaExhibits.length > 0
				? { personaExhibits: input.personaExhibits }
				: {}),
			...(state.pr.files && state.pr.files.length > 0
				? { diffFiles: state.pr.files }
				: {}),
		});
	} catch (error) {
		if (isReviewerCancelledError(error)) {
			return { ok: false, error: `Judge cancelled: ${error.message}` };
		}
		throw error;
	}
	rememberParticipantIdentity(state, "judge", state.council.judge);
	// Capture the note before the commit overwrites the run
	// whose provenance it reads.
	const overwriteNote = stackReviewOverwriteNote(state, pinnedPrNumber);
	commitJudgeRun(state, pinnedPrNumber, run);
	return {
		ok: true,
		run,
		...(overwriteNote ? { warnings: [overwriteNote] } : {}),
	};
}

/**
 * Land a finished judge run on the PR it started on.
 *
 * If the cursor is still there, the run becomes the live
 * `council.lastJudge` and clears the downstream critique +
 * decisions. If the user navigated away, the run merges
 * into that PR's `stackRuns` slot alongside its council
 * run, so the consolidated findings rehydrate on return
 * rather than clobbering the PR now under the cursor.
 */
function commitJudgeRun(
	state: PrWorkflowState,
	pinnedPrNumber: number,
	run: JudgeRun,
): void {
	if (state.pr?.reference.number === pinnedPrNumber) {
		state.council.lastJudge = run;
		state.council.lastCritique = null;
		state.council.decisions = new Map();
		return;
	}
	const existing = state.stackRuns.get(pinnedPrNumber);
	state.stackRuns.set(pinnedPrNumber, {
		lastRun: existing?.lastRun ?? null,
		lastJudge: run,
		lastCritique: null,
		decisions: new Map(),
	});
}

/** Render a `JudgeRun` as a multi-line summary. */
export function formatJudgeSummary(run: JudgeRun): string {
	const lines: string[] = [];
	lines.push(`Judge run ${run.id}`);
	lines.push(`Judge: ${run.judgeReviewerId}`);
	const failureBanner = reviewerFailureBanner([
		{ verification: run.verification, warnings: run.warnings },
	]);
	if (failureBanner) {
		lines.push("");
		lines.push(failureBanner.replace("reviewers", "judge"));
	}
	if (run.selfSignal !== null) {
		lines.push(
			`Self-signal: ${run.selfSignal.confidence} — ${run.selfSignal.rationale}`,
		);
	} else {
		lines.push("Self-signal: (none)");
	}
	lines.push("");
	const count = run.consolidatedFindings.length;
	const noun = count === 1 ? "finding" : "findings";
	lines.push(`${count} consolidated ${noun}:`);
	for (const finding of run.consolidatedFindings) {
		const loc = renderLocation(finding.location);
		const raisedBy = finding.agreement?.raisedBy.join(", ") ?? "judge alone";
		lines.push(
			`  [${finding.id}] [${finding.label}] ${finding.subject} ${loc}`,
		);
		lines.push(`     raised by: ${raisedBy}`);
	}
	if (run.warnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const warning of run.warnings) {
			lines.push(`  ! ${warning}`);
		}
	}
	return lines.join("\n");
}

function renderLocation(
	loc: JudgeRun["consolidatedFindings"][number]["location"],
): string {
	switch (loc.kind) {
		case "line":
			return `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}
