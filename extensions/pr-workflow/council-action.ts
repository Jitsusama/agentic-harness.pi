/**
 * Action handlers for the `council` and `council-config`
 * tool actions.
 *
 * The tool surface in `index.ts` is a thin shell that
 * delegates here. The logic — input validation, dispatch
 * to the orchestrator, state persistence, summary
 * formatting — lives in pure functions for testability.
 */

import { STALE_RUNTIME_WARNING_PREFIX } from "../../lib/subagent/health.js";
import type {
	PrWorkflowConfigLoadResult,
	PrWorkflowReviewerEntry,
} from "./config.js";
import type { CouncilDispatch } from "./council.js";
import { runCouncil, runOneCouncilReviewer } from "./council.js";
import type { CouncilProgress } from "./council-progress.js";
import { ensureCouncilConfigured } from "./ensure-configured.js";
import { reserveFindingIds } from "./finding-ids.js";
import type { CouncilRun } from "./findings.js";
import {
	assertParticipantIdentityAvailable,
	rememberParticipantIdentities,
} from "./participant-identities.js";
import type { ReviewContextProviderBroker } from "./review-context.js";
import { reviewerFailureBanner } from "./reviewer-outcome.js";
import { composeRunAddendum } from "./run-intent.js";
import type { PrWorkflowState } from "./state.js";
import {
	loadReviewThreadPromptContext,
	type ReviewThreadsFetcher,
} from "./thread-context.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Result of a state-mutating action handler. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Inputs for `configureCouncil`. */
export interface ConfigureCouncilInput {
	readonly reviewers: readonly PrWorkflowReviewerEntry[];
}

/**
 * Build a reviewer-id → charter map for a roster. Each reviewer
 * that references a persona is resolved through `resolveCharter`;
 * reviewers with no persona, or whose persona resolves to nothing,
 * are absent from the map and dispatch without a system prompt.
 * Exported so the council and critique actions build the map the
 * same way — critique reuses the same personas.
 */
export function buildCharterMap(
	roster: readonly PrWorkflowReviewerEntry[],
	resolveCharter?: (personaId: string) => string | undefined,
): Map<string, string> {
	const charters = new Map<string, string>();
	if (!resolveCharter) return charters;
	for (const reviewer of roster) {
		if (reviewer.persona === undefined) continue;
		const charter = resolveCharter(reviewer.persona);
		if (charter !== undefined && charter !== "") {
			charters.set(reviewer.id, charter);
		}
	}
	return charters;
}

/**
 * Replace the session roster with the provided reviewers.
 * Validates non-empty and unique ids; errors are
 * structured for the tool layer to surface as text.
 */
export function configureCouncil(
	state: PrWorkflowState,
	input: ConfigureCouncilInput,
): ActionResult {
	if (input.reviewers.length === 0) {
		return {
			ok: false,
			error: "Council roster is empty: provide at least one reviewer.",
		};
	}
	const seen = new Set<string>();
	for (const r of input.reviewers) {
		if (seen.has(r.id)) {
			return {
				ok: false,
				error: `Duplicate reviewer id: "${r.id}". Reviewer ids stamp finding origin and must be unique.`,
			};
		}
		seen.add(r.id);
	}
	const judgeId = state.council.judge?.id;
	if (judgeId && seen.has(judgeId)) {
		return {
			ok: false,
			error: `Reviewer id "${judgeId}" is already used by the judge. Council reviewer ids and judge id must be distinct within a session.`,
		};
	}
	for (const reviewer of input.reviewers) {
		const identity = assertParticipantIdentityAvailable(
			state,
			"reviewer",
			reviewer,
		);
		if (!identity.ok) return identity;
	}
	state.council.roster = input.reviewers.map((r) => ({ ...r }));
	return { ok: true };
}

/** Inputs for `runCouncilAction`. */
export interface RunCouncilActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly reviewContexts?: ReviewContextProviderBroker;
	readonly fetchThreads?: ReviewThreadsFetcher;
	/**
	 * Resolve a persona id to its charter prose. Injected so the
	 * action stays testable without reading persona files; the
	 * tool layer supplies a resolver backed by the persona
	 * directory. The action maps each roster reviewer's `persona`
	 * through this to build the per-reviewer system prompt.
	 */
	readonly resolveCharter?: (personaId: string) => string | undefined;
	/**
	 * The user's per-run intent: the focus for this council run,
	 * merged into the prompt addendum alongside any provider review
	 * context. Standing lens lives in the persona charter; this is
	 * the poke for this one run.
	 */
	readonly intent?: string;
	readonly signal?: AbortSignal;
	/** Override for tests; production uses `Date.now()`. */
	readonly now?: () => Date;
	/** Optional progress observer; forwarded to `runCouncil`. */
	readonly progress?: CouncilProgress;
	/**
	 * Config loader for point-of-use roster and judge
	 * hydration. Injected so tests stay hermetic; production
	 * reads the real pr-workflow config file.
	 */
	readonly loadConfig?: () => Promise<PrWorkflowConfigLoadResult>;
}

/** Result of a council action run. */
export type CouncilActionResult =
	| { ok: true; run: CouncilRun }
	| { ok: false; error: string };

/**
 * Run the council against the currently loaded PR. Stores
 * the resulting `CouncilRun` in `state.council.lastRun`
 * on success.
 */
export async function runCouncilAction(
	input: RunCouncilActionInput,
): Promise<CouncilActionResult> {
	const { state } = input;
	if (state.pr === null) {
		return {
			ok: false,
			error: "No PR is loaded. Call pr_workflow action=load first.",
		};
	}
	// Fill an unset roster and judge from the config file at
	// point of use, so a review just runs instead of stranding
	// the user behind a per-session council-config/judge-config
	// dance. Only errors when the config cannot supply them.
	const configured = await ensureCouncilConfigured(state, input.loadConfig);
	if (!configured.ok) return { ok: false, error: configured.error };

	const pr = state.pr;
	const metadata = pr.metadata;
	if (metadata === null) {
		return {
			ok: false,
			error:
				"PR metadata is missing. Reload the PR before running the council.",
		};
	}
	const files = pr.files ?? [];

	const now = input.now ?? (() => new Date());
	const runId = `council-${now().toISOString()}`;

	const threadContext = await loadReviewThreadPromptContext(
		state,
		input.fetchThreads,
	);

	const target = {
		owner: pr.reference.owner,
		repo: pr.reference.repo,
		sha: metadata.head.sha,
		branch: metadata.head.ref,
		prNumber: pr.reference.number,
		title: metadata.title,
		description: "",
		files,
		threadContext,
	};

	const providerAddendum = await input.reviewContexts?.promptAddendum({
		owner: target.owner,
		repo: target.repo,
		prNumber: target.prNumber,
		sha: target.sha,
		branch: target.branch,
		stage: "council",
	});
	const promptAddendum = composeRunAddendum(providerAddendum, input.intent);

	// Resolve each reviewer's persona to a charter up front, keyed
	// by reviewer id. The map is the council's filesystem-free view
	// of the personas; reviewers with no persona simply aren't in it.
	const charters = buildCharterMap(state.council.roster, input.resolveCharter);

	// Pin to the PR this run started on. The cursor may move
	// (a concurrent action=load) while the fan-out is in
	// flight; the run must commit to its own PR regardless.
	const pinnedPrNumber = pr.reference.number;

	const run = await runCouncil({
		runId,
		target,
		reviewers: state.council.roster,
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
		// Reserve ids synchronously at assignment time so two
		// concurrent runs in one session never overlap.
		allocate: (count) => reserveFindingIds(state, count),
		progress: input.progress,
		charterFor: (id) => charters.get(id),
		cache: state.council.reviewerCache,
		...(promptAddendum ? { promptAddendum } : {}),
	});
	rememberParticipantIdentities(state, "reviewer", state.council.roster);
	commitCouncilRun(state, pinnedPrNumber, run);
	return { ok: true, run };
}

/**
 * Land a finished council run on the PR it started on.
 *
 * If the cursor is still on that PR, the run becomes the
 * live `council.lastRun` and resets the downstream rounds.
 * If the user has since navigated away, the run is stashed
 * in that PR's `stackRuns` slot so it rehydrates on return
 * instead of clobbering the PR now under the cursor.
 */
function commitCouncilRun(
	state: PrWorkflowState,
	pinnedPrNumber: number,
	run: CouncilRun,
): void {
	if (state.pr?.reference.number === pinnedPrNumber) {
		state.council.lastRun = run;
		state.council.lastJudge = null;
		state.council.lastCritique = null;
		state.council.decisions = new Map();
		return;
	}
	state.stackRuns.set(pinnedPrNumber, {
		lastRun: run,
		lastJudge: null,
		lastCritique: null,
		decisions: new Map(),
	});
}

/** Inputs for `retryCouncilReviewer`. */
export interface RetryCouncilReviewerInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly reviewContexts?: ReviewContextProviderBroker;
	readonly fetchThreads?: ReviewThreadsFetcher;
	/**
	 * Resolve a persona id to its charter, so a retried reviewer
	 * keeps its persona voice. Same contract as
	 * {@link RunCouncilActionInput.resolveCharter}.
	 */
	readonly resolveCharter?: (personaId: string) => string | undefined;
	/** The user's per-run intent for this retry; see {@link RunCouncilActionInput.intent}. */
	readonly intent?: string;
	readonly reviewerId: string;
	readonly signal?: AbortSignal;
}

/**
 * Re-run a single reviewer in the most recent council
 * run and substitute their `ReviewerOutput` in place.
 *
 * Finding ids are allocated past the current max so that
 * decisions on un-retried findings stay stable.
 * Decisions on the retried reviewer's previous findings
 * become orphans (no longer present in any run); the
 * post stage already only consults findings present in
 * the current state, so the orphans are harmless.
 */
export async function retryCouncilReviewer(
	input: RetryCouncilReviewerInput,
): Promise<CouncilActionResult> {
	const { state, reviewerId } = input;
	if (state.pr === null) {
		return {
			ok: false,
			error: "No PR is loaded. Call pr_workflow action=load first.",
		};
	}
	const metadata = state.pr.metadata;
	if (metadata === null) {
		return {
			ok: false,
			error:
				"PR metadata is missing. Reload the PR before retrying a reviewer.",
		};
	}
	const lastRun = state.council.lastRun;
	if (lastRun === null) {
		return {
			ok: false,
			error: "No council run to retry. Call pr_workflow action=council first.",
		};
	}
	const reviewer = state.council.roster.find((r) => r.id === reviewerId);
	if (!reviewer) {
		return {
			ok: false,
			error: `Reviewer "${reviewerId}" is not in the current council roster.`,
		};
	}
	const existingIndex = lastRun.reviewerOutputs.findIndex(
		(o) => o.reviewerId === reviewerId,
	);
	if (existingIndex < 0) {
		return {
			ok: false,
			error: `Reviewer "${reviewerId}" has no output in the last council run.`,
		};
	}

	const pr = state.pr;
	const threadContext = await loadReviewThreadPromptContext(
		state,
		input.fetchThreads,
	);
	const target = {
		owner: pr.reference.owner,
		repo: pr.reference.repo,
		sha: metadata.head.sha,
		branch: metadata.head.ref,
		prNumber: pr.reference.number,
		title: metadata.title,
		description: "",
		files: pr.files ?? [],
		threadContext,
	};
	const providerAddendum = await input.reviewContexts?.promptAddendum({
		owner: target.owner,
		repo: target.repo,
		prNumber: target.prNumber,
		sha: target.sha,
		branch: target.branch,
		stage: "council",
	});
	const promptAddendum = composeRunAddendum(providerAddendum, input.intent);
	const charters = buildCharterMap([reviewer], input.resolveCharter);
	const output = await runOneCouncilReviewer({
		runId: lastRun.id,
		target,
		reviewer,
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
		// Placeholder; the allocator below supplies the real
		// base synchronously once findings are parsed.
		startId: 0,
		allocate: (count) => reserveFindingIds(state, count),
		charterFor: (id) => charters.get(id),
		cache: state.council.reviewerCache,
		...(promptAddendum ? { promptAddendum } : {}),
	});
	rememberParticipantIdentities(state, "reviewer", [reviewer]);
	// The retry edits the captured run object in place. That
	// object is whichever run `lastRun` referenced at entry —
	// the live one, or a stashed stackRuns run — so this
	// commits to the right place without re-reading state.pr.
	lastRun.reviewerOutputs[existingIndex] = output;
	return { ok: true, run: lastRun };
}

/**
 * Render a `CouncilRun` as a multi-line summary suitable
 * for surfacing to the user via the tool's `content`.
 */
export function formatCouncilSummary(run: CouncilRun): string {
	const lines: string[] = [];
	lines.push(`Council run ${run.id} on PR #${run.target.prNumber}`);
	lines.push(`Started: ${run.startedAt}`);

	// Lead with a hard failure when every reviewer failed to
	// verify, so an all-crashed run never reads as success.
	const failureBanner = reviewerFailureBanner(run.reviewerOutputs);
	if (failureBanner) {
		lines.push("");
		lines.push(failureBanner);
	}

	// When the pi runtime is stale every reviewer fails
	// identically and no retry will succeed until pi is
	// restarted. Surface a single session-level advisory
	// and suppress the misleading per-reviewer retry hint.
	const staleAdvisory = findStaleRuntimeAdvisory(run.reviewerOutputs);
	if (staleAdvisory) {
		lines.push("");
		lines.push(`⚠ ${staleAdvisory}`);
	} else {
		// Reviewers that produced warnings AND zero findings
		// are the most likely candidates for `council-retry`:
		// the warning explains why they came back empty
		// (crash, parse failure, etc.). Flag them at the top
		// so the user sees the suggestion before scrolling.
		const retryCandidates = run.reviewerOutputs.filter(
			(o) => o.findings.length === 0 && o.warnings.length > 0,
		);
		if (retryCandidates.length > 0) {
			lines.push("");
			for (const c of retryCandidates) {
				lines.push(
					`⚠ ${c.reviewerId} returned no findings with warnings; ` +
						`consider \`pr_workflow action=council-retry reviewerId=${c.reviewerId}\`.`,
				);
			}
		}
	}

	for (const output of run.reviewerOutputs) {
		const count = output.findings.length;
		const noun = count === 1 ? "finding" : "findings";
		const verification = renderVerificationBadge(output.verification);
		const reused = output.reused ? " · reused (input unchanged)" : "";
		lines.push("");
		lines.push(
			`▸ ${output.reviewerId} — ${count} ${noun}${verification}${reused}`,
		);
		const verifyReason = renderVerificationFailureReason(output.verification);
		if (verifyReason) {
			lines.push(`  ! ${verifyReason}`);
		}
		for (const finding of output.findings) {
			const loc = renderLocation(finding.location);
			lines.push(`  • [${finding.label}] ${finding.subject}  ${loc}`);
		}
		for (const warning of output.warnings) {
			lines.push(`  ! ${warning}`);
		}
	}
	return lines.join("\n");
}

/**
 * Return the first stale-runtime advisory found across
 * every reviewer's warnings, or null if none.
 *
 * The same `Pi runtime stale: ...` message lands on every
 * reviewer (the parent's runtime is one path for all of
 * them), so picking the first match is correct.
 */
function findStaleRuntimeAdvisory(
	outputs: readonly CouncilRun["reviewerOutputs"][number][],
): string | null {
	for (const output of outputs) {
		for (const warning of output.warnings) {
			if (warning.startsWith(STALE_RUNTIME_WARNING_PREFIX)) return warning;
		}
	}
	return null;
}

function renderVerificationBadge(
	verification: CouncilRun["reviewerOutputs"][number]["verification"],
): string {
	if (verification === undefined) return "";
	if (verification.ok) return " — verified ✓";
	return verification.called ? " — verification failed" : " — not verified";
}

/**
 * Expand the verification badge into a concrete failure
 * reason when the reviewer's verify_output stage didn't
 * land cleanly. Surfaces the actual schema message so the
 * user doesn't have to dig through state to know whether a
 * reviewer crashed structurally or never reported in.
 */
function renderVerificationFailureReason(
	verification: CouncilRun["reviewerOutputs"][number]["verification"],
): string | null {
	if (verification === undefined || verification.ok) return null;
	if (!verification.called) return "verify_output not called";
	const message = verification.message?.trim();
	return message ? `verify_output failed: ${message}` : "verify_output failed";
}

function renderLocation(
	loc: CouncilRun["reviewerOutputs"][number]["findings"][number]["location"],
): string {
	switch (loc.kind) {
		case "line":
			return loc.start === loc.end
				? `(${loc.file}:${loc.start})`
				: `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}
