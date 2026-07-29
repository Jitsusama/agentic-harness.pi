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

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import {
	type Anchor,
	type AnchorRefusal,
	addFinding,
	anchorable,
	type DiffFile,
	type DraftState,
	emptyDraft,
	type PublishOutcome,
	type PublishPlan,
	type ReviewTarget,
	setVerdict,
	type Verdict,
} from "../../lib/review/index.js";
import type { Finding, FindingAgreement, FindingLocation } from "./findings.js";
import type { PostGateOutcome } from "./post-gate-outcome.js";
import type {
	PostGateFindingLine,
	PostGateSkippedLine,
	PostGateSummary,
} from "./post-gate-render.js";
import { changeFromGitHubView } from "./reference.js";
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

/**
 * An anchored remark on its way out.
 *
 * Still spelled the way GitHub spells it, sides and all, because
 * this is what the rendering here produces and what the anchoring
 * checks read. The translation into the contract's vocabulary
 * happens once, at the submission seam.
 */
export interface ReviewComment {
	readonly path: string;
	readonly line: number;
	readonly startLine?: number;
	/** Diff side: defaults to "RIGHT" when omitted. */
	readonly side?: string;
	readonly body: string;
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
	draft: DraftState;
}) => Promise<PreparedPost>;

/**
 * A staged review: what it will do, and a way to do it.
 *
 * The plan arrives before anything is sent, so the gate shows
 * what will actually happen rather than what a guess about the
 * backend suggested. The summary is passed at publish time
 * because the gate can edit it.
 */
export interface PreparedPost {
	plan(): PublishPlan;
	publish(summary: string): Promise<PublishOutcome>;
}

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
/**
 * Resolve the head-drift warning for a post: fetch the
 * current head and compare it against the reviewed head.
 * Advisory, so a missing resolver or a failed fetch yields
 * null rather than blocking a post the user is ready to send.
 */
async function resolveHeadDrift(
	currentHead: PostReviewActionInput["currentHead"],
	ref: PRReference,
	reviewedSha: string | undefined,
): Promise<string | null> {
	if (!currentHead) return null;
	try {
		return describeHeadDrift(reviewedSha, await currentHead(ref));
	} catch {
		// Head freshness is advisory; a fetch failure must not
		// block a review the user is ready to post.
		return null;
	}
}

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
 * The decided review, composed as a draft the substrate can plan.
 *
 * A draft is what this review will say once the deliberating is
 * over. The council runs, the critiques and the verdicts that
 * produced it stay where they are: they are the record of
 * deciding, and this is the thing decided.
 *
 * What lands inline and what spills into the body is not settled
 * here. Every remark arrives with the anchor it claims, and the
 * plan judges those against a particular provider's diff and
 * limits, which is the only place that judgment is sound.
 */
export function composeDraft(
	state: PrWorkflowState,
	event: ReviewEvent,
): DraftState {
	const reference = state.pr?.reference;
	let draft = emptyDraft(
		`pr-workflow-${reference ? reference.number : "unloaded"}`,
		targetFor(reference),
	);

	for (const finding of state.council.lastJudge?.consolidatedFindings ?? []) {
		const decision = state.council.decisions.get(finding.id);
		if (!decision || !willBeSaid(decision.verdict)) continue;
		draft = addFinding(draft, {
			anchor: anchorOf(effectiveFinding(finding, decision).location),
			body: renderCommentBody(state, finding, decision),
		});
	}

	// A stack review says things about the change in front of you as
	// well as about its neighbours. One that homes elsewhere gets
	// posted there, so saying it here as well would double it.
	for (const finding of state.stackFindingRun?.findings ?? []) {
		if (finding.homePrNumber !== reference?.number) continue;
		const decision = state.stackDecisions.get(finding.id);
		if (!decision || !willBeSaid(decision.verdict)) continue;
		draft = addFinding(draft, {
			// It spans several changes, so no one file in this one is
			// where it belongs.
			anchor: { subject: "change" },
			body: renderStackBodyEntry(state, finding, decision),
		});
	}

	return setVerdict(draft, verdictOf(event));
}

/**
 * Whether a verdict means the remark gets said out loud.
 *
 * A dismissal will not be said, and neither will something queued
 * for a fix, since the fix is the answer to it rather than a
 * comment about it.
 */
function willBeSaid(verdict: FindingDecision["verdict"]): boolean {
	return verdict !== "dismiss" && verdict !== "fix";
}

/** A GitHub review event as the position the contract knows. */
function verdictOf(event: ReviewEvent): Verdict {
	if (event === "APPROVE") return "approve";
	return event === "REQUEST_CHANGES" ? "request-changes" : "comment";
}

/**
 * Where a finding attaches.
 *
 * A remark about the title or the scope names no file, and says
 * so, which is why the plan can spill it into the body for a
 * reason rather than because a path it invented matched nothing.
 */
function anchorOf(location: FindingLocation): Anchor {
	if (location.kind === "line") {
		return {
			subject: "line",
			path: location.file,
			blob: location.side === "old" ? "old" : "new",
			line: location.end,
			...(location.start === location.end ? {} : { startLine: location.start }),
		};
	}
	if (location.kind === "file") {
		return { subject: "file", path: location.file };
	}
	return { subject: "change" };
}

/** What the draft is about, when anything is loaded. */
function targetFor(reference: PRReference | undefined): ReviewTarget {
	if (!reference) {
		return { kind: "range", repo: { key: "" }, base: "", head: "" };
	}
	return { kind: "proposal", change: changeFromGitHubView(reference) };
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

	// Capture the reviewed head before any await so the drift
	// check compares against the diff the payload was built
	// from, not whatever a concurrent load might swap in during
	// the fetch.
	const reviewedHeadSha = input.state.pr.metadata?.head.sha;

	const composed = composeDraft(input.state, input.event);

	// Enforce prose-standard before anything leaves this machine,
	// the same detect-and-block posture the PR, issue and commit
	// guardians use. It runs on what a person actually wrote: the
	// remarks and the caller's prefix. Checking it here rather than
	// after staging means a rejected review never opens a draft, so
	// nothing is persisted about a post that was never allowed.
	if (input.proseGate) {
		const block = input.proseGate([
			...(input.body === undefined ? [] : [input.body]),
			...composed.items.map((item) =>
				item.kind === "finding" ? item.body : "",
			),
		]);
		if (block) return { ok: false, error: block };
	}

	// Stage the review against its provider. The plan is what says
	// which remarks anchor and which end up in the body, and it is
	// the provider's diff and limits that decide, so a gate built
	// on anything else promises what the post will not do.
	let prepared: PreparedPost;
	let plan: PublishPlan;
	try {
		prepared = await input.exec({ ref: targetRef, draft: composed });
		plan = prepared.plan();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Post failed: ${message}` };
	}

	let summary = renderSummary(input.state, payload, input.body, input.event, {
		anchored: anchoredCount(plan),
		inBody: plan.degraded.length,
	});

	// Build the gate summary from the same pre-await state the
	// plan and body were built from, then run the head-drift
	// check (its fetch is the only yield here) and fold the
	// warning in. Doing the read before the await keeps the
	// plan, body and gate summary mutually consistent even if
	// a concurrent load lands during the fetch.
	const gateSummary = input.gate
		? buildGateSummary(input.state, input.event, payload, summary, plan)
		: null;
	const headDriftWarning = await resolveHeadDrift(
		input.currentHead,
		targetRef,
		reviewedHeadSha,
	);
	if (input.gate && gateSummary) {
		const outcome = await input.gate({
			...gateSummary,
			...(headDriftWarning ? { headDriftWarning } : {}),
		});
		if (!outcome.approved) {
			return { ok: false, error: outcome.reason };
		}
		summary = outcome.body;
	}

	try {
		const outcome = await prepared.publish(summary);
		if (!outcome.ok) {
			// The draft holds whatever did not land, so this is
			// recoverable rather than lost.
			return { ok: false, error: describePartialPublish(outcome) };
		}
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

/** How many remarks the plan will attach to a line or a file. */
function anchoredCount(plan: PublishPlan): number {
	let total = 0;
	for (const op of plan.ops) {
		if (op.kind === "review") total += op.comments.length;
	}
	return total;
}

/**
 * What went wrong when only part of a review landed.
 *
 * Naming the operations that failed matters more than the count:
 * the draft kept them, so the person can see what is still owed
 * rather than guessing which half of their review is live.
 */
function describePartialPublish(outcome: PublishOutcome): string {
	const failed = outcome.outcomes.filter((entry) => !entry.ok);
	const reasons = failed
		.map((entry) => entry.error)
		.filter((reason): reason is string => reason !== undefined);
	const detail = reasons.length > 0 ? `: ${reasons.join("; ")}` : "";
	return (
		`Only part of the review landed. ${failed.length} of ` +
		`${outcome.outcomes.length} operations failed${detail}. The draft ` +
		"kept what did not land, so it can be published again rather " +
		"than rewritten."
	);
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
	plan: PublishPlan,
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
		// From the plan, not from this side's guess. The gate is a
		// promise about what pressing Enter does, and only the
		// provider's own diff and limits settle where a remark lands.
		inlineCount: anchoredCount(plan),
		bodyFindingCount: plan.degraded.length,
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
/**
 * Why a finding will not anchor where it says it does, or null
 * when it will.
 *
 * The judgment is the substrate's, so this workflow and the
 * provider that has to accept the comment agree about what lands.
 * What is added here is the wording, since the refusals are
 * vocabulary and a person needs a sentence.
 *
 * Naming the actual refusal matters more than it sounds. The
 * older answer was a bare yes or no, so every warning blamed the
 * line range, including when the file was not in the diff at all,
 * which sent people to correct the one part that was right.
 */
export function whyAnchorFails(
	location: FindingLocation,
	files: readonly DiffFile[],
): string | null {
	if (location.kind !== "line") {
		return "it is not a line-anchored finding, so it has no place in the diff to attach to";
	}
	const check = anchorable({ files: [...files] }, anchorFor(location));
	if (check.anchored) return null;
	return ANCHOR_REFUSALS[check.reason];
}

/** How each refusal reads to someone who has to act on it. */
const ANCHOR_REFUSALS: Record<AnchorRefusal, string> = {
	"file-absent": "that file is not in the diff",
	"line-absent": "those lines are not in the diff",
	"range-inverted": "the range ends before it starts",
	"range-crosses-hunks":
		"the range crosses two hunks, and a remark spanning a gap in the diff is not one remark",
	"not-a-place": "it is about the change as a whole, not about a line",
};

/** A finding's line location as the anchor the substrate judges. */
function anchorFor(location: FindingLocation & { kind: "line" }): Anchor {
	return {
		subject: "line",
		path: location.file,
		blob: location.side === "old" ? "old" : "new",
		line: location.end,
		...(location.start === location.end ? {} : { startLine: location.start }),
	};
}

export function hasValidInlineAnchor(
	location: FindingLocation,
	files: readonly DiffFile[],
): boolean {
	return whyAnchorFails(location, files) === null;
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
	placement?: Placement,
): string {
	const lines: string[] = [];
	if (prefix !== undefined && prefix.trim().length > 0) {
		lines.push(prefix.trim());
		lines.push("");
	}
	lines.push(renderReviewVerdictIntro(state, payload, event, placement));
	// The remarks themselves are not appended here. Whatever could
	// not anchor is written into the body by the plan, which is the
	// only thing that knows what could not: doing it here as well
	// would say each of those twice.
	return lines.join("\n");
}

/** How many remarks landed where, once the plan decided. */
export interface Placement {
	anchored: number;
	inBody: number;
}

function renderReviewVerdictIntro(
	state: PrWorkflowState,
	payload: ReviewPayload,
	event: ReviewEvent,
	placed?: Placement,
): string {
	const findings = includedFindings(state, payload);
	const verdict = reviewVerdict(findings, event);
	const count = findings.length;
	const noun = count === 1 ? "finding" : "findings";
	const placement = renderCommentPlacement(payload, placed);
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

function renderCommentPlacement(
	payload: ReviewPayload,
	placement?: Placement,
): string {
	// Without a plan there is nothing trustworthy to say about
	// where remarks will land, so the sentence says nothing rather
	// than guessing from a split this side computed.
	if (!placement) return "";
	void payload;
	const parts: string[] = [];
	if (placement.anchored > 0) parts.push(`${placement.anchored} inline`);
	if (placement.inBody > 0) {
		parts.push(`${placement.inBody} in the review body`);
	}
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
