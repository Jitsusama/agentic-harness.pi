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
} from "../../../lib/review/index.js";
import type { GateItem, GateView } from "../gate.js";
import {
	anchorLabel,
	anchorView,
	type GatePanel,
	GLYPH,
	gateLines,
	planNarration,
} from "../render.js";

/** A tab on the publish gate, and what rejecting it would drop. */
export interface PublishTab {
	item: GateItem;
	/** Draft items behind this tab. Empty for the Plan tab. */
	itemIds: string[];
}

/** The label the summary tab always carries. */
export const PLAN_TAB = "Plan";

/**
 * One tab per operation, with the plan leading.
 *
 * Labels address what a person can already see: `V` for the review
 * itself, the anchor for a remark, the thread's anchor for a reply or a
 * settling, the author for a reaction. Never a draft item id, which is a
 * sequence number nothing else prints.
 */
export function publishTabs(
	plan: PublishPlan,
	destination: string,
	diff: DiffModel | undefined,
): PublishTab[] {
	const tabs: PublishTab[] = [
		{
			item: {
				label: PLAN_TAB,
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

	const used = new Map<string, number>();
	for (const op of plan.ops) {
		tabs.push({
			item: {
				label: unique(labelForOp(op), used),
				views: viewsFor(op, destination, diff),
			},
			itemIds: op.itemIds,
		});
	}
	return tabs;
}

/**
 * A label nothing else on this panel is using.
 *
 * Two replies onto threads anchored at the same line would otherwise
 * share an address, and rejecting one would drop both.
 */
function unique(label: string, used: Map<string, number>): string {
	const seen = used.get(label) ?? 0;
	used.set(label, seen + 1);
	return seen === 0 ? label : `${label} (${seen + 1})`;
}

/** How this operation is addressed on the tab strip. */
function labelForOp(op: PlannedOp): string {
	if (op.kind === "review") return "V";
	if (op.kind === "comment") return "Message";
	if (op.kind === "commentOn") return anchorLabel(op.comment.anchor);
	if (op.kind === "react") return op.subject.author.id;
	return op.thread.anchor ? anchorLabel(op.thread.anchor) : "thread";
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
				gateLines(
					{
						destination,
						payload: { body: op.body },
						consequence: [`${GLYPH.verdict} ${op.verdict}`],
					},
					theme,
					width,
				),
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
					...gateLines(
						{
							destination,
							where: anchorLabel(op.comment.anchor),
							payload: { body: op.comment.body },
							consequence: [
								`${GLYPH.degrades} posted on its own, since a review will not carry it`,
							],
						},
						theme,
						width,
					),
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
				gateLines(panelFor(op, destination), theme, width),
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
