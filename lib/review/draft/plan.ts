/**
 * Compiling a draft into what will actually be sent.
 *
 * This is where the asymmetries between backends are paid
 * for, once, in the open. A draft says what the reviewer
 * means; a provider's capabilities say what it will accept;
 * the plan says what is therefore going to happen, including
 * what will land somewhere other than where it was aimed and
 * what will not land at all.
 *
 * Nothing here talks to a network. A plan can be shown to a
 * person before a single request is made, which is the whole
 * point: degradation announced up front is a decision, and
 * degradation discovered from a rejected request is a
 * surprise.
 */

import type { Anchor } from "../anchor.js";
import {
	anchorable,
	describeAnchor as sharedDescribeAnchor,
} from "../anchor.js";
import type {
	Capabilities,
	ConversationCapabilities,
} from "../capabilities.js";
import type { ChangeState, ReviewTarget } from "../change.js";
import type {
	AnchoredComment,
	Message,
	Reaction,
	Thread,
	Verdict,
} from "../conversation.js";
import type { DiffModel } from "../diff.js";
import { bullet } from "./continuation.js";
import type { DraftState, FindingItem } from "./state.js";

/** What the compiler needs to know beyond the draft itself. */
export interface PlanContext {
	capabilities: Capabilities;
	/**
	 * Diff to validate anchors against. Without one, anchors
	 * are taken on trust: better to let the backend judge than
	 * to invent a refusal.
	 */
	diff?: DiffModel;
	/** True when the reviewer authored the change. */
	ownChange?: boolean;
	/** Where the change stands, when known. */
	changeState?: ChangeState;
}

/** One request that will be made. */
export type PlannedOp =
	| {
			kind: "review";
			verdict: Verdict;
			body: string;
			comments: AnchoredComment[];
			itemIds: string[];
	  }
	| { kind: "comment"; body: string; itemIds: string[] }
	| {
			/**
			 * One anchored remark, posted on its own.
			 *
			 * For a remark a batch review will not carry. Both backends
			 * surveyed reject a whole review that contains a file-level
			 * comment while accepting the same comment posted alone, so this
			 * is what keeps one such remark from costing every other remark
			 * beside it.
			 */
			kind: "commentOn";
			comment: AnchoredComment;
			itemIds: string[];
	  }
	| { kind: "reply"; thread: Thread; body: string; itemIds: string[] }
	| { kind: "resolve"; thread: Thread; itemIds: string[] }
	| { kind: "unresolve"; thread: Thread; itemIds: string[] }
	| {
			kind: "react";
			subject: Message;
			reaction: Reaction;
			itemIds: string[];
	  };

/** An item that will land, but not the way it was asked for. */
export interface Degradation {
	itemId: string;
	/** What was asked for. */
	from: string;
	/** What will happen instead. */
	to: string;
	reason: string;
}

/** Something that will not happen, and why. */
export interface PlanRefusal {
	/** Item it came from, absent when it is about the verdict. */
	itemId?: string;
	subject: string;
	reason: string;
}

/** Everything that will happen when this draft is published. */
export interface PublishPlan {
	target: ReviewTarget;
	ops: PlannedOp[];
	degraded: Degradation[];
	refused: PlanRefusal[];
}

/** A verdict taking no position, which is the safe default. */
const NEUTRAL_VERDICT: Verdict = "comment";

/** Where a finding was aimed, for a reader of the plan. */
function describeAnchor(anchor: Anchor): string {
	if (anchor.subject !== "line") return sharedDescribeAnchor(anchor);
	return `${sharedDescribeAnchor(anchor)} (${anchor.blob})`;
}

/** A finding rendered into prose, for when it cannot anchor. */
function inlineFinding(finding: FindingItem): string {
	return bullet(describeAnchor(finding.anchor), finding.body);
}

/**
 * Assemble the review body: the reviewer's summary, then any
 * findings that could not be anchored, so nothing the person
 * wrote is silently dropped.
 */
function reviewBody(
	summary: string | undefined,
	spilled: FindingItem[],
): string {
	const parts: string[] = [];
	if (summary) parts.push(summary);
	if (spilled.length > 0) {
		parts.push(
			"Remarks that could not be attached to a line:",
			spilled.map(inlineFinding).join("\n"),
		);
	}
	return parts.join("\n\n");
}

/** Narrow a multi-line anchor to its last line. */
function collapseRange(anchor: Anchor): Anchor {
	if (anchor.subject !== "line") return anchor;
	const { startLine, ...rest } = anchor;
	void startLine;
	return rest;
}

/** The outcome of sorting one finding. */
interface SortedFinding {
	comment?: AnchoredComment;
	/** Posted on its own, because a batch will not carry it. */
	alone?: AnchoredComment;
	spill?: FindingItem;
	degradation?: Degradation;
}

/**
 * Decide how one finding will travel: as an anchored comment,
 * as a narrowed anchored comment, or as prose in the body.
 */
function sortFinding(
	finding: FindingItem,
	conversation: ConversationCapabilities,
	diff: DiffModel | undefined,
): SortedFinding {
	const spillTo = "the review body";
	if (finding.anchor.subject === "file") {
		if (conversation.fileLevelComments === "never") {
			return {
				spill: finding,
				degradation: {
					itemId: finding.id,
					from: "a file-level comment",
					to: spillTo,
					reason: "this provider does not anchor comments to a whole file",
				},
			};
		}
		if (conversation.fileLevelComments === "standalone") {
			// Out of the batch and onto its own post, which is where both
			// backends surveyed will take it. In the batch it does not merely
			// fail, it takes the whole review down with it, so this is not a
			// preference: a review carrying one file-level remark was rejected
			// entirely, and every other remark in it was lost to a retry.
			//
			// No degradation is recorded, because nothing about the remark
			// changed. It lands where it was aimed, said by the same person
			// about the same file; only the request carrying it is different,
			// and that is the provider's business rather than the author's.
			return { alone: { anchor: finding.anchor, body: finding.body } };
		}
	}

	if (diff) {
		const check = anchorable(diff, finding.anchor);
		if (!check.anchored) {
			return {
				spill: finding,
				degradation: {
					itemId: finding.id,
					from: `an anchor at ${describeAnchor(finding.anchor)}`,
					to: spillTo,
					reason: `the anchor does not land on this diff (${check.reason})`,
				},
			};
		}
	}

	const ranged =
		finding.anchor.subject === "line" &&
		finding.anchor.startLine !== undefined &&
		finding.anchor.startLine !== finding.anchor.line;
	if (ranged && !conversation.multiLineRanges) {
		return {
			comment: { anchor: collapseRange(finding.anchor), body: finding.body },
			degradation: {
				itemId: finding.id,
				from: `a range at ${describeAnchor(finding.anchor)}`,
				to: "a single-line comment on its last line",
				reason: "this provider does not accept multi-line ranges",
			},
		};
	}

	return { comment: { anchor: finding.anchor, body: finding.body } };
}

/** Whether a verdict is allowed, and why not when it is not. */
function verdictRefusal(
	verdict: Verdict,
	summary: string | undefined,
	conversation: ConversationCapabilities,
	context: PlanContext,
): string | undefined {
	if (conversation.bodyRequiredFor?.includes(verdict) && !summary) {
		return `this provider requires a summary for a ${verdict} verdict`;
	}
	if (
		context.ownChange &&
		conversation.selfVerdicts &&
		!conversation.selfVerdicts.includes(verdict)
	) {
		return `this provider does not accept a ${verdict} verdict on your own change`;
	}
	if (
		context.changeState === "merged" &&
		conversation.verdictsAfterMerge &&
		!conversation.verdictsAfterMerge.includes(verdict)
	) {
		return `this provider does not accept a ${verdict} verdict once merged`;
	}
	return undefined;
}

/** A plan fragment, before the parts are joined. */
interface Fragment {
	ops: PlannedOp[];
	degraded: Degradation[];
	refused: PlanRefusal[];
}

/** Nothing can be published: say so for every part of the draft. */
function refuseEverything(state: DraftState): Fragment {
	const reason =
		"this target has no conversation to publish to; render the " +
		"review as a document instead";
	const refused: PlanRefusal[] = state.items.map((item) => ({
		itemId: item.id,
		subject: item.kind,
		reason,
	}));
	if (state.verdict) refused.push({ subject: "verdict", reason });
	return { ops: [], degraded: [], refused };
}

/**
 * Plan the review itself: the verdict, the summary, and every
 * finding, each either anchored or folded into the body.
 */
function planReview(
	state: DraftState,
	conversation: ConversationCapabilities,
	context: PlanContext,
): Fragment {
	const degraded: Degradation[] = [];
	const refused: PlanRefusal[] = [];
	const comments: AnchoredComment[] = [];
	/** Remarks the batch will not carry, each posted on its own. */
	const alone: { comment: AnchoredComment; itemId: string }[] = [];
	const spilled: FindingItem[] = [];
	const itemIds: string[] = [];

	const findings = state.items.filter(
		(item): item is FindingItem => item.kind === "finding",
	);

	for (const finding of findings) {
		itemIds.push(finding.id);

		if (!conversation.anchoredBatchReview) {
			spilled.push(finding);
			degraded.push({
				itemId: finding.id,
				from: "an anchored comment",
				to: "prose in a top-level message",
				reason: "this provider cannot post anchored comments in a review",
			});
			continue;
		}

		const sorted = sortFinding(finding, conversation, context.diff);
		if (sorted.degradation) degraded.push(sorted.degradation);
		if (sorted.spill) spilled.push(sorted.spill);
		if (sorted.alone) {
			alone.push({ comment: sorted.alone, itemId: finding.id });
			continue;
		}
		if (!sorted.comment) continue;

		const cap = conversation.maxBatchComments;
		if (cap !== undefined && comments.length >= cap) {
			spilled.push(finding);
			degraded.push({
				itemId: finding.id,
				from: "an anchored comment",
				to: "the review body",
				reason: `this provider caps a batch at ${cap} comments`,
			});
			continue;
		}
		comments.push(sorted.comment);
	}

	let verdict = state.verdict;
	if (verdict) {
		const reason = verdictRefusal(
			verdict,
			state.summary,
			conversation,
			context,
		);
		if (reason) {
			refused.push({ subject: `${verdict} verdict`, reason });
			verdict = undefined;
		}
	}

	// Each on its own, so one that the backend refuses costs only itself.
	const standalone: PlannedOp[] = alone.map(({ comment, itemId }) => ({
		kind: "commentOn",
		comment,
		itemIds: [itemId],
	}));

	if (findings.length === 0 && verdict === undefined) {
		return { ops: standalone, degraded, refused };
	}

	// Nothing left for the review itself is possible now that a remark can
	// travel on its own: a draft holding one file-level finding and no
	// verdict has its whole content in the standalone ops, and an empty
	// review posted beside them would be a message saying nothing.
	const onlyStandalone =
		comments.length === 0 &&
		spilled.length === 0 &&
		verdict === undefined &&
		state.summary === undefined &&
		standalone.length > 0;
	if (onlyStandalone) return { ops: standalone, degraded, refused };

	const body = reviewBody(state.summary, spilled);
	const op: PlannedOp = conversation.anchoredBatchReview
		? {
				kind: "review",
				verdict: verdict ?? NEUTRAL_VERDICT,
				body,
				comments,
				itemIds,
			}
		: { kind: "comment", body, itemIds };
	return { ops: [op, ...standalone], degraded, refused };
}

/**
 * Plan the parts no backend accepts inside a review: replies
 * into existing threads, resolutions and reactions.
 */
function planThreadWork(
	state: DraftState,
	conversation: ConversationCapabilities,
): Fragment {
	const ops: PlannedOp[] = [];
	const refused: PlanRefusal[] = [];

	for (const item of state.items) {
		if (item.kind === "reply") {
			// A thread with no anchor is a top-level message the provider hung off
			// the change, and not every backend lets a reply thread onto one. The
			// capability saying so was declared by every provider and read by none,
			// so this was planned as landing and rejected at submit: the worst
			// moment to find out, and the exact case the capability exists for.
			if (item.thread.anchor === undefined && !conversation.topLevelThreading) {
				refused.push({
					itemId: item.id,
					subject: "reply",
					reason:
						"this provider cannot thread a reply onto a top-level message; " +
						"say it as a comment on the change instead",
				});
			} else {
				ops.push({
					kind: "reply",
					thread: item.thread,
					body: item.body,
					itemIds: [item.id],
				});
			}
		} else if (item.kind === "resolution") {
			if (item.thread.resolved) {
				refused.push({
					itemId: item.id,
					subject: "resolution",
					reason: "that thread is already resolved",
				});
			} else {
				ops.push({
					kind: "resolve",
					thread: item.thread,
					itemIds: [item.id],
				});
			}
		} else if (item.kind === "unresolution") {
			if (!item.thread.resolved) {
				refused.push({
					itemId: item.id,
					subject: "unresolution",
					reason: "that thread is not resolved",
				});
			} else {
				ops.push({
					kind: "unresolve",
					thread: item.thread,
					itemIds: [item.id],
				});
			}
		} else if (item.kind === "reaction") {
			if (conversation.reactions.includes(item.reaction)) {
				ops.push({
					kind: "react",
					subject: item.subject,
					reaction: item.reaction,
					itemIds: [item.id],
				});
			} else {
				refused.push({
					itemId: item.id,
					subject: "reaction",
					reason:
						conversation.reactions.length === 0
							? "this provider does not support reactions"
							: `this provider does not accept the ${item.reaction} reaction`,
				});
			}
		}
	}

	return { ops, degraded: [], refused };
}

/**
 * Compile a draft into an explicit plan.
 *
 * Findings and the verdict become one review where the
 * provider batches anchored comments, since that is one
 * notification rather than a dozen. Replies, resolutions and
 * reactions are their own requests because no backend accepts
 * them inside a review. The review goes first, so its
 * comments exist before anything refers to them.
 */
export function compilePlan(
	state: DraftState,
	context: PlanContext,
): PublishPlan {
	const conversation = context.capabilities.conversation;
	const parts = conversation
		? [
				planReview(state, conversation, context),
				planThreadWork(state, conversation),
			]
		: [refuseEverything(state)];

	return {
		target: state.target,
		ops: parts.flatMap((part) => part.ops),
		degraded: parts.flatMap((part) => part.degraded),
		refused: parts.flatMap((part) => part.refused),
	};
}
