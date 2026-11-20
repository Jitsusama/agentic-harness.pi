/**
 * Moving a session whose own key is over its cap onto a budget.
 *
 * A proxy that meters the person's own key refuses every call once
 * the key is over its cap, with a 403 that no retry gets past, and a
 * session that rests on it sits idle until somebody notices. So the
 * workflow that sees the refusal (model-retry) asks, over the bus,
 * for the budget the person named for this (quest-workflow's keeper,
 * `budgetWhenCapped`), and tries the turn again once one is laid.
 * The ask is answered at once with a promise, so an asker can tell no
 * keeper from a keeper that found nothing.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../internal/record.ts";

/** The bus event a session asks on for a budget, its own key being capped. */
export const BUDGET_CAPPED = "budget:capped:v1";

/**
 * How long, by the wall clock, a session the cap moved stays on the
 * budget named for it before its own key is drawn on again: the cap
 * lifts when its week turns or the person claims more, and a call
 * refused once more costs nothing but the move back. A refusal after
 * it may ask to move again.
 */
export const CAP_MOVE_LASTS_MS = 60 * 60_000;

/** What {@link BUDGET_CAPPED} carries. */
export interface BudgetCappedAsk {
	/** Why the session's own key can't be drawn on, in a line. */
	readonly because: string;
	/**
	 * Called at once by the keeper with the budget it will lay, or
	 * null once it finds it has none to lay.
	 */
	readonly answer: (drawn: Promise<string | null>) => void;
	/** Whether a keeper has answered already, so no other lays a budget. */
	readonly answered: () => boolean;
}

/**
 * Whether a failed call's error is a proxy refusing the person's own
 * key for being over its cap: a 403 saying the personal token usage
 * is over, or naming `usage_cap_exceeded`. Seen on 19 November in 116
 * replies, each ending a turn that then sat idle.
 */
export function isCapRefusal(errorMessage: string | undefined): boolean {
	if (!errorMessage || !/\b403\b/.test(errorMessage)) return false;
	return /personal token usage is over|usage_cap_exceeded/i.test(errorMessage);
}

/**
 * Ask whoever keeps the session's budget to lay the one named for a
 * capped key: the budget laid, or null when nothing keeps one or the
 * keeper has none to lay.
 */
export function askBudgetWhenCapped(
	bus: Pick<EventBus, "emit">,
	because: string,
): Promise<string | null> {
	let drawn: Promise<string | null> | undefined;
	const ask: BudgetCappedAsk = {
		because,
		answer: (promise) => {
			drawn ??= promise;
		},
		answered: () => drawn !== undefined,
	};
	bus.emit(BUDGET_CAPPED, ask);
	return (drawn ?? Promise.resolve(null)).catch(() => null);
}

/**
 * Answer {@link BUDGET_CAPPED} with `take`, which lays a budget for a
 * capped key and says which, or null, unless another keeper answered
 * first. Returns the unsubscribe.
 */
export function onBudgetCapped(
	bus: Pick<EventBus, "on">,
	take: (because: string) => Promise<string | null>,
): () => void {
	return bus.on(BUDGET_CAPPED, (data) => {
		if (!isCappedAsk(data) || data.answered()) return;
		data.answer(take(data.because));
	});
}

function isCappedAsk(data: unknown): data is BudgetCappedAsk {
	return (
		isRecord(data) &&
		typeof data.because === "string" &&
		typeof data.answer === "function" &&
		typeof data.answered === "function"
	);
}
