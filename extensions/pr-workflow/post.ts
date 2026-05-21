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
import type { PostGateOutcome } from "./post-gate-outcome.js";
import type {
	PostGateFindingLine,
	PostGateSkippedLine,
	PostGateSummary,
} from "./post-gate-render.js";
import type { StackFinding } from "./stack-findings.js";
import type { PrWorkflowState } from "./state.js";
import type { FindingDecision } from "./synthesis.js";

/** Review event sent to GitHub. */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

const VALID_EVENTS: ReadonlySet<ReviewEvent> = new Set([
	"COMMENT",
	"APPROVE",
	"REQUEST_CHANGES",
]);

const LABEL_EMOJI: Record<Finding["label"], string> = {
	praise: "👏",
	nitpick: "🔍",
	suggestion: "💡",
	issue: "⚠️",
	todo: "✅",
	question: "❓",
	thought: "💭",
	chore: "🧹",
	note: "📝",
};

interface ConventionalCommentHeaderInput {
	readonly label: Finding["label"];
	readonly decorations?: readonly string[];
	readonly subject: string;
}

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
	/**
	 * Stack-level finding ids included in this payload.
	 * Separate from `includedFindingIds` because the two
	 * id spaces don't share a namespace; tracking them
	 * apart lets the post summary count each kind.
	 */
	readonly includedStackFindingIds: number[];
	readonly skipped: SkippedFinding[];
}

/** Exec boundary: wraps `gh api` for testability. */
export type PostReviewExec = (input: {
	ref: PRReference;
	event: ReviewEvent;
	body: string;
	comments: ReviewComment[];
}) => Promise<void>;

/**
 * Confirmation gate boundary. Production wires this to
 * `confirmPostGate`; tests inject deterministic
 * approvals so they don't need the TUI.
 */
export type PostReviewGate = (
	summary: PostGateSummary,
) => Promise<PostGateOutcome>;

/** Inputs to `postReviewAction`. */
export interface PostReviewActionInput {
	readonly state: PrWorkflowState;
	readonly event: ReviewEvent;
	/** Optional caller-supplied prefix prepended to the generated summary. */
	readonly body?: string;
	readonly exec: PostReviewExec;
	/**
	 * Optional confirmation gate. When supplied, the
	 * action calls it after building the payload and
	 * before invoking `exec`. A rejected outcome short-
	 * circuits with `ok: false` and the gate's reason;
	 * an approved outcome can override the body.
	 */
	readonly gate?: PostReviewGate;
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
			includedStackFindingIds: [],
			skipped: [],
		};
	}

	const inline: ReviewComment[] = [];
	const bodyLines: string[] = [];
	const includedFindingIds: number[] = [];
	const includedStackFindingIds: number[] = [];
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

	const cursorPrNumber = state.pr?.reference.number ?? null;
	const stackFindingRun = state.stackFindingRun;
	if (stackFindingRun !== null) {
		for (const finding of stackFindingRun.findings) {
			if (cursorPrNumber === null || finding.homePrNumber !== cursorPrNumber) {
				skipped.push({
					findingId: finding.id,
					reason: `stack: homes to PR #${finding.homePrNumber}, not current cursor`,
				});
				continue;
			}
			const decision = state.stackDecisions.get(finding.id) ?? null;
			if (decision === null) {
				skipped.push({
					findingId: finding.id,
					reason: "stack: pending, no user decision",
				});
				continue;
			}
			if (decision.verdict === "dismiss") {
				skipped.push({ findingId: finding.id, reason: "stack: dismiss" });
				continue;
			}
			if (decision.verdict === "fix") {
				skipped.push({
					findingId: finding.id,
					reason: "stack: queued for fix (not posted)",
				});
				continue;
			}
			bodyLines.push(renderStackBodyEntry(finding, decision));
			includedStackFindingIds.push(finding.id);
		}
	}

	const body = bodyLines.length > 0 ? bodyLines.join("\n\n") : "";
	return {
		comments: inline,
		body,
		includedFindingIds,
		includedStackFindingIds,
		skipped,
	};
}

/**
 * Render a stack-level finding as a body entry. Same
 * Conventional Comments shape as per-PR body entries
 * plus a cross-PR header listing the spanned PRs so
 * readers know what else the finding refers to.
 */
function renderStackBodyEntry(
	finding: StackFinding,
	decision: FindingDecision,
): string {
	const subject = effectiveSubject(finding, decision);
	const discussion = effectiveDiscussion(finding, decision);
	const lines: string[] = [];
	const spansSentence =
		finding.spans.length === 1
			? `cross-PR: spans #${finding.spans[0]}`
			: `cross-PR: spans #${finding.spans.join(", #")}`;
	lines.push(
		renderConventionalCommentHeader({
			label: finding.label,
			decorations: finding.decorations,
			subject,
		}),
	);
	lines.push("");
	lines.push(`_${spansSentence}_`);
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
	if (
		payload.includedFindingIds.length === 0 &&
		payload.includedStackFindingIds.length === 0
	) {
		return {
			ok: false,
			error:
				"No findings eligible for posting. Decide on findings before calling action=post.",
		};
	}

	let summary = renderSummary(input.state, payload, input.body);
	if (input.gate) {
		const outcome = await input.gate(
			buildGateSummary(input.state, input.event, payload, summary),
		);
		if (!outcome.approved) {
			return { ok: false, error: outcome.reason };
		}
		summary = outcome.body;
	}
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

/**
 * Build the structured summary the gate renders.
 *
 * Lives next to the action so the body lookup logic
 * (find a judge / cross-PR finding by id) stays
 * close to the payload that produced the ids.
 */
function buildGateSummary(
	state: PrWorkflowState,
	event: ReviewEvent,
	payload: ReviewPayload,
	body: string,
): PostGateSummary {
	const judgeFindings = state.council.lastJudge?.consolidatedFindings ?? [];
	const stackFindings = state.stackFindingRun?.findings ?? [];
	const byId = new Map<number, Finding>();
	for (const f of judgeFindings) byId.set(f.id, f);
	const stackById = new Map<number, StackFinding>();
	for (const f of stackFindings) stackById.set(f.id, f);

	const lines: PostGateFindingLine[] = [];
	for (const id of payload.includedFindingIds) {
		const finding = byId.get(id);
		if (!finding) continue;
		lines.push({
			id: finding.id,
			label: finding.label,
			subject: finding.subject,
			location: renderLocationForBody(finding.location),
		});
	}
	for (const id of payload.includedStackFindingIds) {
		const finding = stackById.get(id);
		if (!finding) continue;
		lines.push({
			id: finding.id,
			label: finding.label,
			subject: finding.subject,
			location: `cross-PR · #${finding.homePrNumber}`,
		});
	}

	const skipped: PostGateSkippedLine[] = payload.skipped.map((entry) => ({
		displayId: entry.reason.startsWith("stack:")
			? `S${entry.findingId}`
			: String(entry.findingId),
		reason: entry.reason,
	}));

	return {
		event,
		body,
		inlineCount: payload.comments.length,
		bodyFindingCount:
			payload.includedFindingIds.length +
			payload.includedStackFindingIds.length -
			payload.comments.length,
		stackFindingCount: payload.includedStackFindingIds.length,
		skippedCount: payload.skipped.length,
		findings: lines,
		skipped,
	};
}

function renderCommentBody(
	finding: Finding,
	decision: FindingDecision,
): string {
	const subject = effectiveSubject(finding, decision);
	const discussion = effectiveDiscussion(finding, decision);
	const lines: string[] = [];
	lines.push(
		renderConventionalCommentHeader({
			label: finding.label,
			decorations: finding.decorations,
			subject,
		}),
	);
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
	lines.push(
		renderConventionalCommentHeader({
			label: finding.label,
			decorations: finding.decorations,
			subject,
		}),
	);
	lines.push("");
	lines.push(`_${where}_`);
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

function renderConventionalCommentHeader(
	input: ConventionalCommentHeaderInput,
): string {
	const decorations = renderDecorations(input.decorations);
	return `${input.label}${decorations}: ${LABEL_EMOJI[input.label]} ${input.subject}`;
}

function renderDecorations(decorations: readonly string[] | undefined): string {
	const normalized = (decorations ?? [])
		.map((decoration) => decoration.trim())
		.filter((decoration) => decoration.length > 0);
	return normalized.length === 0 ? "" : ` (${normalized.join(", ")})`;
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
	const stackCount = payload.includedStackFindingIds.length;
	const stackSentence =
		stackCount === 0 ? "" : ` Plus ${stackCount} cross-PR finding(s) included.`;
	lines.push(
		`Council review: ${payload.includedFindingIds.length} finding(s) included, ${payload.skipped.length} skipped.${stackSentence}`,
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
