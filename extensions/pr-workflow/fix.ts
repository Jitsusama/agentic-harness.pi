/**
 * Fix queue mechanics for the back half of the review.
 *
 * Findings the user decided to fix (rather than post) are
 * recorded with `verdict: "fix"` on the regular
 * `FindingDecision`. This module walks those decisions in
 * a defined order, hands the next one to the main agent
 * loop with enough context to apply the edit, and records
 * the outcome so subsequent walks skip already-handled
 * findings.
 *
 * The walk is non-autonomous on purpose: the agent calls
 * `getNextFix` to learn what to work on, then does the
 * actual edits, checks, and commit in its main loop where
 * the user can interrupt with prose at any moment. Once a
 * commit lands the agent calls `recordFixDone` to mark the
 * finding resolved. To abandon a queued fix without
 * committing, `recordFixSkip` records the reason.
 */

import type { Finding } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import type { PrWorkflowState } from "./state.js";
import type { FindingDecision } from "./synthesis.js";

/**
 * Everything the agent needs to apply one fix in its main
 * loop. The tool action returns this; the agent reads,
 * edits, runs checks, and commits using its normal
 * toolkit.
 */
/**
 * The PR a fix should land on: its repo coordinates and the
 * branch to check out. For a per-PR finding this is the
 * loaded cursor PR; for a cross-PR stack finding it is the
 * finding's home PR, so a stack fix commits to the right
 * branch rather than the cursor's.
 */
export interface FixTarget {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly branch: string;
}

export interface FixContext {
	/** Id of the finding being addressed. */
	readonly findingId: number;
	/**
	 * Full finding record from the last judge run. The
	 * agent reads `location`, `subject`, and `discussion`
	 * to know what file to edit and why.
	 */
	readonly finding: Finding;
	/**
	 * Optional user-supplied note attached at decision
	 * time. Free-form prose; the agent treats it as
	 * additional guidance on how to apply the fix.
	 */
	readonly instructions: string | null;
	/**
	 * The PR this fix should land on, or null when no PR is
	 * loaded or its branch is unknown. A per-PR finding
	 * targets the cursor; a cross-PR stack finding targets
	 * its home PR.
	 */
	readonly target: FixTarget | null;
	/**
	 * Home PR number for a cross-PR stack finding; absent
	 * for a per-PR finding, whose home is the cursor.
	 */
	readonly homePrNumber?: number;
}

/** Counts shown in `status` and `fix-next`'s summary. */
export interface FixQueueSummary {
	/** Fix-verdicted findings with no recorded outcome. */
	readonly pending: number;
	/** Fix-verdicted findings recorded as committed. */
	readonly committed: number;
	/** Fix-verdicted findings the user abandoned. */
	readonly skipped: number;
}

/**
 * Return the next pending fix, or `null` when the queue
 * is empty. Pending = `verdict: "fix"` with neither
 * `resolvedBy` nor `skipped` set. Order follows the judge
 * run's finding order so the queue is deterministic.
 */
export function getNextFix(state: PrWorkflowState): FixContext | null {
	const judge = state.council.lastJudge;
	const cursorTarget = cursorFixTarget(state);
	if (judge !== null) {
		for (const finding of judge.consolidatedFindings) {
			const decision = state.council.decisions.get(finding.id);
			if (!decision || decision.verdict !== "fix") continue;
			if (decision.resolvedBy || decision.skipped) continue;
			return {
				findingId: finding.id,
				finding,
				instructions: decision.instructions ?? null,
				target: cursorTarget,
			};
		}
	}

	// Per-PR fixes drain first; then cross-PR stack findings,
	// each targeting its home PR so the fix commits to the
	// right branch rather than the cursor's.
	const stackRun = state.stackFindingRun;
	if (stackRun !== null) {
		for (const finding of stackRun.findings) {
			const decision = state.stackDecisions.get(finding.id);
			if (!decision || decision.verdict !== "fix") continue;
			if (decision.resolvedBy || decision.skipped) continue;
			return {
				findingId: finding.id,
				finding,
				instructions: decision.instructions ?? null,
				target: homeFixTarget(state, finding.homePrNumber) ?? cursorTarget,
				homePrNumber: finding.homePrNumber,
			};
		}
	}
	return null;
}

/** The loaded cursor PR as a fix target, or null if unusable. */
function cursorFixTarget(state: PrWorkflowState): FixTarget | null {
	const pr = state.pr;
	const branch = pr?.metadata?.head.ref;
	if (!pr || !branch) return null;
	return {
		owner: pr.reference.owner,
		repo: pr.reference.repo,
		number: pr.reference.number,
		branch,
	};
}

/** Resolve a stack finding's home PR to a fix target from the stack. */
function homeFixTarget(
	state: PrWorkflowState,
	homePrNumber: number,
): FixTarget | null {
	const entry = state.pr?.stack?.entries.find(
		(e) => e.reference.number === homePrNumber,
	);
	if (!entry) return null;
	return {
		owner: entry.reference.owner,
		repo: entry.reference.repo,
		number: entry.reference.number,
		branch: entry.headRefName,
	};
}

/** Aggregate counts across the fix queue for the loaded PR. */
export function summarizeFixQueue(state: PrWorkflowState): FixQueueSummary {
	let pending = 0;
	let committed = 0;
	let skipped = 0;
	const count = (decision: FindingDecision): void => {
		if (decision.verdict !== "fix") return;
		if (decision.resolvedBy) committed++;
		else if (decision.skipped) skipped++;
		else pending++;
	};
	for (const decision of state.council.decisions.values()) count(decision);
	for (const decision of state.stackDecisions.values()) count(decision);
	return { pending, committed, skipped };
}

/** Result of mutating a fix's outcome. */
export type FixOutcomeResult = { ok: true } | { ok: false; error: string };

/**
 * Record that a fix-verdicted finding was addressed by a
 * commit. Fails when the finding has no fix decision,
 * already has an outcome, or the commit sha is empty.
 */
export function recordFixDone(
	state: PrWorkflowState,
	findingId: number,
	commitSha: string,
	now: () => Date = () => new Date(),
): FixOutcomeResult {
	const sha = commitSha.trim();
	if (sha.length === 0) {
		return { ok: false, error: "commit sha must not be empty" };
	}
	const located = locateFixDecision(state, findingId);
	if (!located.ok) return located;
	located.map.set(findingId, {
		...located.decision,
		resolvedBy: { commitSha: sha, recordedAt: now().toISOString() },
	});
	return { ok: true };
}

type FixDecision = Extract<FindingDecision, { verdict: "fix" }>;

type LocatedFixDecision =
	| { ok: true; map: Map<number, FindingDecision>; decision: FixDecision }
	| { ok: false; error: string };

/**
 * Find the fix-verdicted, unresolved decision for a finding
 * in whichever decision map holds it (per-PR or stack), or
 * return the reason it cannot be recorded against.
 */
function locateFixDecision(
	state: PrWorkflowState,
	findingId: number,
): LocatedFixDecision {
	const map = state.council.decisions.has(findingId)
		? state.council.decisions
		: state.stackDecisions.has(findingId)
			? state.stackDecisions
			: null;
	const decision = map?.get(findingId);
	if (!map || !decision) {
		return { ok: false, error: `no decision for finding ${findingId}` };
	}
	if (decision.verdict !== "fix") {
		return {
			ok: false,
			error: `finding ${findingId} is not queued for fix (verdict: ${decision.verdict})`,
		};
	}
	if (decision.resolvedBy) {
		return {
			ok: false,
			error: `finding ${findingId} already recorded as fixed in ${decision.resolvedBy.commitSha}`,
		};
	}
	if (decision.skipped) {
		return {
			ok: false,
			error: `finding ${findingId} already recorded as skipped`,
		};
	}
	return { ok: true, map, decision };
}

/**
 * Record that a fix-verdicted finding was abandoned
 * without a commit. The reason is required so the
 * findings view can explain why the finding isn't going
 * anywhere.
 */
export function recordFixSkip(
	state: PrWorkflowState,
	findingId: number,
	reason: string,
	now: () => Date = () => new Date(),
): FixOutcomeResult {
	const trimmed = reason.trim();
	if (trimmed.length === 0) {
		return { ok: false, error: "skip reason must not be empty" };
	}
	const located = locateFixDecision(state, findingId);
	if (!located.ok) return located;
	located.map.set(findingId, {
		...located.decision,
		skipped: { reason: trimmed, recordedAt: now().toISOString() },
	});
	return { ok: true };
}

/**
 * Re-export used by tests and the action layer so they
 * don't have to dig into `findings.js` for the type.
 */
export type { Finding, JudgeRun };
