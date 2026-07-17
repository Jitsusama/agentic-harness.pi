/**
 * Post gate — turn round-4 decisions into a real GitHub
 * review.
 *
 * Two layers, mirroring `judge-action` / `critique-action`:
 *
 *   - `buildReviewPayload(state)` — pure function. Picks
 *     findings worth posting (verdicts: endorse, qualify,
 *     edit, promote), renders bodies in Conventional
 *     Comments format, uses valid inline anchors when
 *     available, and falls back to the body for file,
 *     global or unanchorable line findings.
 *   - `postReviewAction({ state, event, body?, exec })`
 *     — refuses bad state, calls the injected exec
 *     boundary that wraps `gh api`.
 *
 * The exec boundary takes the burden of subprocess
 * mocking off the action handler, so unit tests don't
 * need a real `gh` binary.
 */

import type { DiffFile, DiffLine } from "../../lib/internal/github/diff.js";
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
import { effectiveFinding, type FindingDecision } from "./synthesis.js";
import { renderThreadRelationForGithub } from "./thread-context.js";

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
	/**
	 * Optional prose gate. When supplied, the action runs it
	 * over the review summary and every inline comment body
	 * before the confirmation gate. A returned string is a
	 * skill-grounded block message: the post short-circuits
	 * with `ok: false` so the AI repairs the prose against
	 * prose-standard before the review reaches GitHub.
	 */
	readonly proseGate?: (texts: string[]) => string | undefined;
	/**
	 * Optional resolver for the PR's current head sha. When
	 * supplied, the action compares it against the head the
	 * diff was reviewed against and warns on drift, so stale
	 * inline anchors are never posted silently. Returning
	 * `undefined` (or throwing) skips the check.
	 */
	readonly currentHead?: (ref: PRReference) => Promise<string | undefined>;
}

/** Result of `postReviewAction`. */
export type PostReviewActionResult =
	| { ok: true; payload: ReviewPayload; warnings?: readonly string[] }
	| { ok: false; error: string };

/**
 * Describe how the PR head drifted between the reviewed diff
 * and now. Returns `null` when the shas match or either is
 * unknown; otherwise a sentence naming both short shas so the
 * user can judge whether the inline anchors are still sound.
 */
export function describeHeadDrift(
	reviewedSha: string | undefined,
	currentSha: string | undefined,
): string | null {
	if (!reviewedSha || !currentSha) return null;
	if (reviewedSha === currentSha) return null;
	const short = (sha: string): string => sha.slice(0, 7);
	return (
		`The PR head advanced from ${short(reviewedSha)} to ${short(currentSha)} ` +
		"since the diff was loaded. The inline anchors were computed against the " +
		"reviewed head, so some comments may land on the wrong lines. Reload the PR " +
		"to re-fetch the diff and re-review, or post knowing the anchors may be stale."
	);
}

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
	const diffFiles = state.pr?.files ?? [];
	const validateInlineAnchors = diffFiles.length > 0;

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
		const body = renderCommentBody(state, finding, decision);
		const location = effectiveFinding(finding, decision).location;
		if (
			location.kind === "line" &&
			(!validateInlineAnchors || hasValidInlineAnchor(location, diffFiles))
		) {
			const comment: ReviewComment = {
				path: location.file,
				line: location.end,
				body,
			};
			if (location.start !== location.end) {
				(comment as { startLine: number }).startLine = location.start;
			}
			(comment as { side: string }).side =
				location.side === "old" ? "LEFT" : "RIGHT";
			inline.push(comment);
		} else {
			bodyLines.push(renderBodyEntry(state, finding, decision));
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
			bodyLines.push(renderStackBodyEntry(state, finding, decision));
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
	state: PrWorkflowState,
	finding: StackFinding,
	decision: FindingDecision,
): string {
	const { subject, discussion, label, decorations } = effectiveFinding(
		finding,
		decision,
	);
	const lines: string[] = [];
	const spansSentence =
		finding.spans.length === 1
			? `cross-PR: spans #${finding.spans[0]}`
			: `cross-PR: spans #${finding.spans.join(", #")}`;
	lines.push(
		renderConventionalCommentHeader({
			label,
			decorations,
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
	const relation = renderThreadRelationNote(state, finding);
	if (relation !== null) {
		lines.push("");
		lines.push(relation);
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
	if (input.state.pr.files === null) {
		return {
			ok: false,
			error: "PR diff is not loaded. Run action=load before posting.",
		};
	}
	// Capture the target reference before any gate await. A
	// concurrent action=load can swap state.pr.reference while
	// the gate is open; the post must land on the PR the user
	// actually reviewed, not whatever the cursor moved to.
	const targetRef = input.state.pr.reference;
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

	// Detect whether the PR head advanced since the diff was
	// reviewed. The reviewed head is the sha the loaded
	// metadata (and therefore the diff and its anchors)
	// corresponds to; a fresh fetch tells us the current head.
	// A failed fetch is non-fatal: we simply skip the check.
	let headDriftWarning: string | null = null;
	if (input.currentHead) {
		try {
			const currentSha = await input.currentHead(targetRef);
			headDriftWarning = describeHeadDrift(
				input.state.pr.metadata?.head.sha,
				currentSha,
			);
		} catch {
			// Head freshness is advisory; a fetch failure must
			// not block a review the user is ready to post.
			headDriftWarning = null;
		}
	}

	let summary = renderSummary(input.state, payload, input.body, input.event);

	// Enforce prose-standard on the review text before the user
	// ever sees the confirmation gate, the same detect-and-block
	// posture the PR, issue and commit guardians use. The summary
	// carries the body-level findings; the comment bodies carry
	// the inline ones, so both are scanned.
	if (input.proseGate) {
		const block = input.proseGate([
			summary,
			...payload.comments.map((comment) => comment.body),
		]);
		if (block) return { ok: false, error: block };
	}

	if (input.gate) {
		const outcome = await input.gate(
			buildGateSummary(input.state, input.event, payload, summary, {
				...(headDriftWarning ? { headDriftWarning } : {}),
			}),
		);
		if (!outcome.approved) {
			return { ok: false, error: outcome.reason };
		}
		summary = outcome.body;
	}
	try {
		await input.exec({
			ref: targetRef,
			event: input.event,
			body: summary,
			comments: payload.comments,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Post failed: ${message}` };
	}
	return {
		ok: true,
		payload: { ...payload, body: summary },
		...(headDriftWarning ? { warnings: [headDriftWarning] } : {}),
	};
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
	extras: { headDriftWarning?: string } = {},
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
		const projected = effectiveFinding(
			finding,
			state.council.decisions.get(id) ?? null,
		);
		lines.push({
			id: projected.id,
			label: projected.label,
			subject: projected.subject,
			location: renderLocationForBody(projected.location),
		});
	}
	for (const id of payload.includedStackFindingIds) {
		const finding = stackById.get(id);
		if (!finding) continue;
		const projected = effectiveFinding(
			finding,
			state.stackDecisions.get(id) ?? null,
		);
		lines.push({
			id: projected.id,
			label: projected.label,
			subject: projected.subject,
			location: `cross-PR · #${projected.homePrNumber}`,
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
		...(extras.headDriftWarning
			? { headDriftWarning: extras.headDriftWarning }
			: {}),
	};
}

function renderCommentBody(
	state: PrWorkflowState,
	finding: Finding,
	decision: FindingDecision,
): string {
	const { subject, discussion, label, decorations } = effectiveFinding(
		finding,
		decision,
	);
	const lines: string[] = [];
	lines.push(
		renderConventionalCommentHeader({
			label,
			decorations,
			subject,
		}),
	);
	lines.push("");
	lines.push(discussion);
	if (decision.verdict === "qualify") {
		lines.push("");
		lines.push(`> Qualifier: ${decision.note}`);
	}
	const relation = renderThreadRelationNote(state, finding);
	if (relation !== null) {
		lines.push("");
		lines.push(relation);
	}
	const provenance = renderProvenance(finding.agreement);
	if (provenance !== null) {
		lines.push("");
		lines.push(provenance);
	}
	return lines.join("\n");
}

function renderBodyEntry(
	state: PrWorkflowState,
	finding: Finding,
	decision: FindingDecision,
): string {
	const projected = effectiveFinding(finding, decision);
	const { subject, discussion, label, decorations } = projected;
	const where = renderLocationForBody(projected.location);
	const lines: string[] = [];
	lines.push(
		renderConventionalCommentHeader({
			label,
			decorations,
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
	const relation = renderThreadRelationNote(state, finding);
	if (relation !== null) {
		lines.push("");
		lines.push(relation);
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

/**
 * Decide whether a line-kind finding location anchors
 * cleanly to a PR diff. Returns false for non-line
 * locations, ranges with invalid start/end ordering,
 * files not in the diff, or line ranges that don't fall
 * inside any hunk of the file. Used at both post time
 * (to decide between inline comment and body fallback)
 * and decide time (to warn the user about findings that
 * would silently degrade to body).
 */
export function hasValidInlineAnchor(
	location: FindingLocation,
	files: readonly DiffFile[],
): boolean {
	if (location.kind !== "line") return false;
	if (location.start < 1 || location.end < location.start) return false;
	const file = files.find((candidate) => candidate.path === location.file);
	if (file === undefined) return false;
	const side = location.side === "old" ? "old" : "new";
	return file.hunks.some((hunk) =>
		hunkContainsLineRange(hunk.lines, location.start, location.end, side),
	);
}

function hunkContainsLineRange(
	lines: readonly DiffLine[],
	start: number,
	end: number,
	side: "old" | "new",
): boolean {
	const lineNumbers = new Set<number>();
	for (const line of lines) {
		const lineNumber = side === "old" ? line.oldLineNumber : line.newLineNumber;
		if (lineNumber !== null) lineNumbers.add(lineNumber);
	}
	for (let lineNumber = start; lineNumber <= end; lineNumber++) {
		if (!lineNumbers.has(lineNumber)) return false;
	}
	return true;
}

/**
 * Build the wrapped review body the gate displays and
 * `post` sends to GitHub. Exposed so `preview-post`
 * `verbose:true` can show the same text without
 * duplicating the framing logic.
 */
export function renderSummary(
	state: PrWorkflowState,
	payload: ReviewPayload,
	prefix: string | undefined,
	event: ReviewEvent,
): string {
	const lines: string[] = [];
	if (prefix !== undefined && prefix.trim().length > 0) {
		lines.push(prefix.trim());
		lines.push("");
	}
	lines.push(renderReviewVerdictIntro(state, payload, event));
	if (payload.body.length > 0) {
		lines.push("");
		lines.push(payload.body);
	}
	return lines.join("\n");
}

function renderReviewVerdictIntro(
	state: PrWorkflowState,
	payload: ReviewPayload,
	event: ReviewEvent,
): string {
	const findings = includedFindings(state, payload);
	const verdict = reviewVerdict(findings, event);
	const count = findings.length;
	const noun = count === 1 ? "finding" : "findings";
	const placement = renderCommentPlacement(payload);
	const priority = verdict === "PASS" ? "" : renderPrioritySentence(findings);
	const threads = renderThreadContextSentence(state, findings);
	return [
		`**${verdict}:** I'm posting ${count} ${noun}${placement}.`,
		priority,
		threads,
	]
		.filter((part) => part.length > 0)
		.join(" ");
}

/**
 * Build the list of findings the review body summary
 * sees. Each finding is projected through its recorded
 * decision so the verdict line, priority sentence and
 * actionable-label check observe the user's edits
 * instead of the raw council output.
 */
function includedFindings(
	state: PrWorkflowState,
	payload: ReviewPayload,
): Finding[] {
	const byId = new Map<number, Finding>();
	for (const finding of state.council.lastJudge?.consolidatedFindings ?? []) {
		byId.set(finding.id, finding);
	}
	const stackById = new Map<number, StackFinding>();
	for (const finding of state.stackFindingRun?.findings ?? []) {
		stackById.set(finding.id, finding);
	}
	return [
		...payload.includedFindingIds.flatMap((id) => {
			const finding = byId.get(id);
			if (finding === undefined) return [];
			return [
				effectiveFinding(finding, state.council.decisions.get(id) ?? null),
			];
		}),
		...payload.includedStackFindingIds.flatMap((id) => {
			const finding = stackById.get(id);
			if (finding === undefined) return [];
			return [effectiveFinding(finding, state.stackDecisions.get(id) ?? null)];
		}),
	];
}

function reviewVerdict(
	findings: readonly Finding[],
	event: ReviewEvent,
): string {
	if (event === "APPROVE") return "PASS";
	if (event === "REQUEST_CHANGES") {
		return findings.some((finding) => finding.severity === "critical")
			? "BLOCK"
			: "NEEDS REVIEW";
	}
	if (findings.some((finding) => finding.severity === "critical")) {
		return "BLOCK";
	}
	if (findings.some((finding) => finding.severity === "medium")) {
		return "NEEDS REVIEW";
	}
	return findings.some(isActionableFinding) ? "GO WITH FIXES" : "PASS";
}

function renderCommentPlacement(payload: ReviewPayload): string {
	const inline = payload.comments.length;
	const body = countBodyFindings(payload);
	const parts: string[] = [];
	if (inline > 0) parts.push(`${inline} inline`);
	if (body > 0) parts.push(`${body} in the review body`);
	return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function renderPrioritySentence(findings: readonly Finding[]): string {
	const priority =
		findings.find((finding) => finding.severity === "critical") ??
		findings.find((finding) => finding.severity === "medium") ??
		findings[0];
	if (priority === undefined) return "";
	return `Prioritize ${priority.subject}.`;
}

function renderThreadContextSentence(
	state: PrWorkflowState,
	findings: readonly Finding[],
): string {
	if (state.threadContextWarning !== null) {
		return `Thread context warning: ${state.threadContextWarning}`;
	}
	if (findings.some((finding) => finding.threadRelation !== undefined)) {
		return "I related this to existing review threads instead of starting from scratch.";
	}
	if ((state.threads?.threads.length ?? 0) > 0) {
		return "I checked the existing review threads and avoided repeating them.";
	}
	return "";
}

function isActionableFinding(finding: Finding): boolean {
	return ["issue", "todo", "suggestion", "question"].includes(finding.label);
}

function countBodyFindings(payload: ReviewPayload): number {
	return (
		payload.includedFindingIds.length +
		payload.includedStackFindingIds.length -
		payload.comments.length
	);
}

function renderThreadRelationNote(
	state: PrWorkflowState,
	finding: Finding,
): string | null {
	const relation = renderThreadRelationForGithub(
		finding.threadRelation,
		state.threads?.threads,
	);
	return relation === null ? null : `_Thread context: ${relation}_`;
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
