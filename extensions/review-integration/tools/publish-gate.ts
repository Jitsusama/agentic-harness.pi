/**
 * The gate that sends a review, and what it shows.
 *
 * It used to show `planNarration` and nothing else: op counts and raw
 * thread uuids, not one word of the text about to go on somebody else's
 * change. The gate that sends the most showed the least.
 *
 * Now every operation gets a tab and every tab shows its payload whole.
 * The Plan tab leads, carrying the narration, the degradations and the
 * refusals, so the summary is still the first thing read. Rejecting a tab
 * drops the draft items behind it and the plan is compiled again without
 * them, which makes the gate the last chance to drop a remark rather than
 * something you have to run `review_draft drop` for before you can see
 * what you would be dropping.
 *
 * Tabs come from operations rather than draft items on purpose. An
 * operation is what will actually be sent, and the review operation
 * carries several remarks in one request: splitting it into a tab per
 * remark would offer a rejection the backend cannot honour, and pairing
 * remarks back to items would be guesswork, since the compiler does not
 * record which comment came from which item. Each remark is a view
 * instead, so all of them can be read before the one request is approved.
 */

import type {
	DiffModel,
	PlannedOp,
	PublishPlan,
} from "@jitsusama/agentic-harness.core/review";
import type { GateItem, GateView } from "../gate.js";
import { REDIRECT_QUOTE_WIDTH } from "../gate.js";
import {
	anchorLabel,
	anchorView,
	type GatePanel,
	GLYPH,
	gateLines,
	gateText,
	planNarration,
} from "../render.js";

/** A tab on the publish gate, and what rejecting it would drop. */
export interface PublishTab {
	item: GateItem;
	/** Draft items behind this tab. Empty for the summary tab. */
	itemIds: string[];
	/**
	 * True for the summary tab, which stands for the whole publish.
	 *
	 * A flag rather than a label comparison, because a label is a glyph
	 * several tabs may share and is for people to read. Rejecting this
	 * one across a stack drops the whole change.
	 */
	summary?: boolean;
}

/** What the summary tab is called when a tab needs naming in prose. */
export const PLAN_TAB = "Plan";

/**
 * One tab per operation, with the plan leading.
 *
 * Labelled the way `review_say` labels a batch, since it is the same
 * strip: a glyph for the kind of thing, and the strip's own running
 * number for which one. Two tabs are allowed to read alike, because a
 * decision comes back as a position rather than a name.
 */
export function publishTabs(
	plan: PublishPlan,
	destination: string,
	diff: DiffModel | undefined,
): PublishTab[] {
	const tabs: PublishTab[] = [
		{
			summary: true,
			item: {
				label: GLYPH.stack,
				plain: planNarration(plan),
				views: [
					{
						key: "1",
						label: "Plan",
						content: (theme, width) =>
							gateLines(
								{ destination, payload: { body: planNarration(plan) } },
								theme,
								width,
							),
					},
				],
			},
			itemIds: [],
		},
	];

	for (const op of plan.ops) {
		tabs.push({
			item: {
				label: glyphForOp(op),
				plain: gateText(primaryPanelFor(op, destination), REDIRECT_QUOTE_WIDTH),
				views: viewsFor(op, destination, diff),
			},
			itemIds: op.itemIds,
		});
	}
	return tabs;
}

/**
 * What kind of thing this operation is, as a mark.
 *
 * The same vocabulary `review_say` uses, so a person who has read one
 * gate can read the other. A verdict is the review's own triangle, a
 * remark on a line is the smaller one inside it, and settling is the box
 * the thread is left in.
 */
function glyphForOp(op: PlannedOp): string {
	if (op.kind === "review") return GLYPH.verdict;
	if (op.kind === "comment") return GLYPH.document;
	if (op.kind === "commentOn") return GLYPH.finding;
	if (op.kind === "react") return GLYPH.reaction;
	if (op.kind === "resolve") return GLYPH.resolved;
	if (op.kind === "unresolve") return GLYPH.unresolved;
	return GLYPH.reply;
}

/**
 * The panel behind a tab's first view.
 *
 * Hoisted out of the views because two things need it and they must not
 * drift: the view draws it, and a redirect quotes it back as text. A
 * second construction for the quote would eventually describe something
 * other than what was on screen, which is the one thing a quote must
 * not do.
 */
export function primaryPanelFor(op: PlannedOp, destination: string): GatePanel {
	if (op.kind === "review") {
		return {
			destination,
			payload: { body: op.body },
			consequence: [`${GLYPH.verdict} ${op.verdict}`],
		};
	}
	if (op.kind === "commentOn") {
		return {
			destination,
			where: anchorLabel(op.comment.anchor),
			payload: { body: op.comment.body },
			consequence: [
				`${GLYPH.degrades} posted on its own, since a review will not carry it`,
			],
		};
	}
	return panelFor(op, destination);
}

/** What can be looked at on this tab. */
function viewsFor(
	op: PlannedOp,
	destination: string,
	diff: DiffModel | undefined,
): GateView[] {
	if (op.kind === "review") {
		const summary: GateView = {
			key: "1",
			label: "Review",
			content: (theme, width) =>
				gateLines(primaryPanelFor(op, destination), theme, width),
		};
		// One view per remark, so every word going out can be read before the
		// one request carrying all of them is approved.
		const remarks: GateView[] = op.comments.map((comment, at) => ({
			key: String(at + 2),
			label: `F${at + 1}`,
			allowHScroll: true,
			content: (theme, width) => [
				...gateLines(
					{
						destination,
						where: anchorLabel(comment.anchor),
						payload: { body: comment.body },
					},
					theme,
					width,
				),
				"",
				...anchorView(comment.anchor, diff, theme, width),
			],
		}));
		return [summary, ...remarks];
	}

	if (op.kind === "commentOn") {
		return [
			{
				key: "1",
				label: "Remark",
				allowHScroll: true,
				content: (theme, width) => [
					...gateLines(primaryPanelFor(op, destination), theme, width),
					"",
					...anchorView(op.comment.anchor, diff, theme, width),
				],
			},
		];
	}

	return [
		{
			key: "1",
			label: viewLabel(op),
			content: (theme, width) =>
				gateLines(primaryPanelFor(op, destination), theme, width),
		},
	];
}

/** The footer label for an operation's only view. */
function viewLabel(op: PlannedOp): string {
	if (op.kind === "react") return "Comment";
	if (op.kind === "resolve" || op.kind === "unresolve") return "Thread";
	return "Message";
}

/** What one non-review operation is about. */
function panelFor(op: PlannedOp, destination: string): GatePanel {
	if (op.kind === "comment") {
		return { destination, payload: { body: op.body } };
	}
	if (op.kind === "react") {
		return {
			destination,
			context: [{ who: op.subject.author.id, body: op.subject.body }],
			consequence: [`${GLYPH.reaction} ${op.reaction}`],
		};
	}
	if (op.kind !== "reply" && op.kind !== "resolve" && op.kind !== "unresolve") {
		return { destination };
	}

	const where = op.thread.anchor
		? anchorLabel(op.thread.anchor)
		: "on the change";
	const context = op.thread.comments.map((one) => ({
		who: one.author.id,
		body: one.body,
	}));
	if (op.kind === "reply") {
		return {
			destination,
			where,
			context,
			payload: { as: "replying", body: op.body },
		};
	}
	const reopening = op.kind === "unresolve";
	return {
		destination,
		where,
		context,
		consequence: [
			`${reopening ? GLYPH.unresolved : GLYPH.resolved} ${reopening ? "reopens" : "resolves"} the thread`,
		],
	};
}
