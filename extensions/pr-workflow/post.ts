/**
 * Post gate — turn round-4 decisions into a real GitHub
 * review.
 *
 * Two layers, mirroring `judge-action` / `critique-action`:
 *
 *   - `buildReviewPayload(state)` — pure function. Picks
 *     findings worth posting (verdicts: endorse, qualify,
 *     edit, promote), renders bodies in Conventional
 *     Comments format, splits into inline comments
 *     (line-located) vs body summary (file/global).
 *   - `postReviewAction({ state, event, body?, exec })`
 *     — refuses bad state, calls the injected exec
 *     boundary that wraps `gh api`.
 *
 * The exec boundary takes the burden of subprocess
 * mocking off the action handler, so unit tests don't
 * need a real `gh` binary.
 */

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { ReviewComment } from "../../lib/internal/github/review-post.js";
import type { Finding, FindingAgreement, FindingLocation } from "./findings.js";
import type { PrWorkflowState } from "./state.js";
import type { FindingDecision } from "./synthesis.js";

/** Review event sent to GitHub. */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

const VALID_EVENTS: ReadonlySet<ReviewEvent> = new Set([
	"COMMENT",
	"APPROVE",
	"REQUEST_CHANGES",
]);

/** Why a finding didn't post. */
export interface SkippedFinding {
	readonly findingId: number;
	readonly reason: string;
}

/** Result of `buildReviewPayload`. */
export interface ReviewPayload {
	readonly comments: ReviewComment[];
	readonly body: string;
	readonly includedFindingIds: number[];
	readonly skipped: SkippedFinding[];
}

/** Exec boundary: wraps `gh api` for testability. */
export type PostReviewExec = (input: {
	ref: PRReference;
	event: ReviewEvent;
	body: string;
	comments: ReviewComment[];
}) => Promise<void>;

/** Inputs to `postReviewAction`. */
export interface PostReviewActionInput {
	readonly state: PrWorkflowState;
	readonly event: ReviewEvent;
	/** Optional caller-supplied prefix prepended to the generated summary. */
	readonly body?: string;
	readonly exec: PostReviewExec;
}

/** Result of `postReviewAction`. */
export type PostReviewActionResult =
	| { ok: true; payload: ReviewPayload }
	| { ok: false; error: string };

/**
 * Render the working state as a GitHub review payload.
 * Pure: no side effects, no I/O.
 */
export function buildReviewPayload(state: PrWorkflowState): ReviewPayload {
	const judge = state.council.lastJudge;
	if (judge === null) {
		return {
			comments: [],
			body: "",
			includedFindingIds: [],
			skipped: [],
		};
	}

	const inline: ReviewComment[] = [];
	const bodyLines: string[] = [];
	const includedFindingIds: number[] = [];
	const skipped: SkippedFinding[] = [];

	for (const finding of judge.consolidatedFindings) {
		const decision = state.council.decisions.get(finding.id) ?? null;
		if (decision === null) {
			skipped.push({
				findingId: finding.id,
				reason: "pending: no user decision",
			});
			continue;
		}
		if (decision.verdict === "dismiss") {
			skipped.push({ findingId: finding.id, reason: "dismiss" });
			continue;
		}
		if (decision.verdict === "fix") {
			skipped.push({
				findingId: finding.id,
				reason: "queued for fix (not posted)",
			});
			continue;
		}
		const body = renderCommentBody(finding, decision);
		if (finding.location.kind === "line") {
			const comment: ReviewComment = {
				path: finding.location.file,
				line: finding.location.end,
				body,
			};
			if (finding.location.start !== finding.location.end) {
				(comment as { startLine: number }).startLine = finding.location.start;
			}
			(comment as { side: string }).side =
				finding.location.side === "old" ? "LEFT" : "RIGHT";
			inline.push(comment);
		} else {
			bodyLines.push(renderBodyEntry(finding, decision));
		}
		includedFindingIds.push(finding.id);
	}

	const body = bodyLines.length > 0 ? bodyLines.join("\n\n") : "";
	return { comments: inline, body, includedFindingIds, skipped };
}

/**
 * Post the review via the injected exec boundary.
 * Refuses bad state (missing PR, no eligible findings,
 * invalid event) and surfaces exec failures as errors.
 */
export async function postReviewAction(
	input: PostReviewActionInput,
): Promise<PostReviewActionResult> {
	if (!VALID_EVENTS.has(input.event)) {
		return {
			ok: false,
			error: `Unknown review event "${input.event}". Use COMMENT, APPROVE, or REQUEST_CHANGES.`,
		};
	}
	if (input.state.pr === null) {
		return { ok: false, error: "No PR loaded; call action=load first." };
	}
	const payload = buildReviewPayload(input.state);
	if (payload.includedFindingIds.length === 0) {
		return {
			ok: false,
			error:
				"No findings eligible for posting. Decide on findings before calling action=post.",
		};
	}

	const summary = renderSummary(input.state, payload, input.body);
	try {
		await input.exec({
			ref: input.state.pr.reference,
			event: input.event,
			body: summary,
			comments: payload.comments,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Post failed: ${message}` };
	}
	return { ok: true, payload: { ...payload, body: summary } };
}

function renderCommentBody(
	finding: Finding,
	decision: FindingDecision,
): string {
	const subject = effectiveSubject(finding, decision);
	const discussion = effectiveDiscussion(finding, decision);
	const lines: string[] = [];
	lines.push(`**${finding.label}:** ${subject}`);
	lines.push("");
	lines.push(discussion);
	if (decision.verdict === "qualify") {
		lines.push("");
		lines.push(`> Qualifier: ${decision.note}`);
	}
	const provenance = renderProvenance(finding.agreement);
	if (provenance !== null) {
		lines.push("");
		lines.push(provenance);
	}
	return lines.join("\n");
}

function renderBodyEntry(finding: Finding, decision: FindingDecision): string {
	const subject = effectiveSubject(finding, decision);
	const discussion = effectiveDiscussion(finding, decision);
	const where = renderLocationForBody(finding.location);
	const lines: string[] = [];
	lines.push(`### [${finding.label}] ${subject} ${where}`);
	lines.push("");
	lines.push(discussion);
	if (decision.verdict === "qualify") {
		lines.push("");
		lines.push(`> Qualifier: ${decision.note}`);
	}
	const provenance = renderProvenance(finding.agreement);
	if (provenance !== null) {
		lines.push("");
		lines.push(provenance);
	}
	return lines.join("\n");
}

function renderSummary(
	state: PrWorkflowState,
	payload: ReviewPayload,
	prefix: string | undefined,
): string {
	const lines: string[] = [];
	if (prefix !== undefined && prefix.trim().length > 0) {
		lines.push(prefix.trim());
		lines.push("");
	}
	lines.push(
		`Council review: ${payload.includedFindingIds.length} finding(s) posted, ${payload.skipped.length} skipped.`,
	);
	const judge = state.council.lastJudge;
	if (judge !== null && judge.selfSignal !== null) {
		lines.push(
			`Judge self-signal: ${judge.selfSignal.confidence} — ${judge.selfSignal.rationale}`,
		);
	}
	if (payload.body.length > 0) {
		lines.push("");
		lines.push("---");
		lines.push("");
		lines.push(payload.body);
	}
	return lines.join("\n");
}

function effectiveSubject(finding: Finding, decision: FindingDecision): string {
	if (decision.verdict === "edit" && typeof decision.subject === "string") {
		return decision.subject;
	}
	return finding.subject;
}

function effectiveDiscussion(
	finding: Finding,
	decision: FindingDecision,
): string {
	if (decision.verdict === "edit" && typeof decision.discussion === "string") {
		return decision.discussion;
	}
	return finding.discussion;
}

function renderProvenance(
	agreement: FindingAgreement | undefined,
): string | null {
	if (!agreement) return null;
	if (agreement.raisedBy.length === 0) return null;
	return `_Raised by: ${agreement.raisedBy.join(", ")}._`;
}

function renderLocationForBody(loc: FindingLocation): string {
	switch (loc.kind) {
		case "line":
			return `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}
