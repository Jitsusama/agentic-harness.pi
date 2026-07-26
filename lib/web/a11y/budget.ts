/**
 * Keeping a page outline inside a response.
 *
 * The outline is the most-returned payload in the whole family:
 * every read of a page answers with one, and so does every
 * navigation and every action, because the page after the fact is
 * how a caller knows what their click did. Lists have been
 * budgeted since the beginning. The outline was not, and a page
 * whose outline is small is only the common case, not the rule:
 * one source file of eighteen thousand lines, each line a
 * listitem with a button and a text node, renders two and a half
 * megabytes of perfectly good outline. A wheel scroll returned
 * all of it.
 *
 * So the same rule as everywhere else. The limit is a
 * presentation default rather than a ceiling, whole lines survive
 * rather than bytes, and anything cut says so and says how to go
 * and get it. The page is not the answer's size: narrowing the
 * view is always available, and it is cheaper than reading the
 * whole thing and discarding it.
 */

import { type BudgetedView, withinLineBudget } from "../../result/view.js";

/**
 * What an explicit read of a page spends on the outline.
 *
 * Generous, because somebody who asked to see the page wants the
 * page: this fits a normal application view whole and only bites
 * on the pathological ones.
 */
export const OUTLINE_BUDGET_BYTES = 16_384;

/**
 * What the page view after an action spends.
 *
 * Tighter, because this outline was not asked for. It is
 * confirmation of what just happened, and the caller who wants
 * the page in full can read it in full.
 */
export const ACTION_VIEW_BUDGET_BYTES = 4_096;

/** An outline cut to fit, and what fitting it cost. */
export interface BudgetedOutline extends BudgetedView {
	/** What was cut and how to read it, when anything was. */
	readonly elided?: string;
}

/**
 * As much of an outline as the budget affords, and never none.
 *
 * The cutting is the general rule from `lib/result`; what belongs
 * to the page is the advice about what to do next, since narrowing
 * a page read has its own vocabulary.
 */
export function withinOutlineBudget(
	rendered: string,
	budget: number,
): BudgetedOutline {
	const view = withinLineBudget(rendered, budget);
	return {
		...view,
		...(view.cut > 0
			? { elided: outlineElision(view.cut, view.total, budget) }
			: {}),
	};
}

/**
 * Say what the budget cut, and how the caller reads it anyway.
 *
 * Every escape named here is one this tool family actually
 * offers, because a suggestion that does not work is worse than
 * no suggestion: it costs a call to find out.
 */
function outlineElision(cut: number, total: number, budget: number): string {
	return (
		`Cut ${cut.toLocaleString()} of ${total.toLocaleString()} outline ` +
		`lines to fit the ${budget.toLocaleString()} byte budget. The page ` +
		"is whole; this view is not. Narrow it rather than enlarging it: " +
		"'only' reduces to landmarks, headings or interactive elements, " +
		"'depth' keeps the top levels, 'within' reads one branch. Or raise " +
		"'budget' to spend more of the response on it."
	);
}
