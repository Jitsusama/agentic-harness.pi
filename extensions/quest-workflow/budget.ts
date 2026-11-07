/**
 * The loaded quest's budget, laid over this session's environment.
 *
 * Quest-workflow hosts the budget providers (lib/budget/host.ts), since
 * it is what knows which quest a session is on. When the session
 * starts and after every quest action, it works out the budget the
 * loaded quest draws on (its own, or its nearest ancestor's), asks
 * the providers what that name means and lays the answer over
 * `process.env`, putting back what was there when the quest draws on
 * none or the session puts it down. Model providers read their keys
 * from the environment as each request is made, so the next request
 * draws on it; commands and subagents started afterwards inherit it.
 * A session started for another quest does not: the terminal it opens
 * in is handed the environment without a budget on it
 * (lib/core/internal/terminal/drivers/shared.ts), and that session
 * draws on its own quest's.
 *
 * A name no provider knows, or one a provider cannot draw on now,
 * leaves the session on its default and says why, once a name. The
 * status line says the budget drawn on, and the session's log says it
 * too (lib/budget/record.ts), each time it changes, so whatever prices
 * the log knows whose money each request spent. Nothing of it goes
 * into the prompt: what a session bills is the person's to see, not
 * the model's to reason about.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { layBudget, liftBudget } from "../../lib/budget/environment.ts";
import { type BudgetDrawing, hostBudgets } from "../../lib/budget/host.ts";
import {
	BUDGET_ENTRY,
	type BudgetRecord,
	budgetDrawnOn,
	lastRecorded,
} from "../../lib/budget/record.ts";
import { budgetInRecord } from "../../lib/internal/quest/budget.ts";
import type { QuestState } from "./state.ts";

/** The status line's key for the budget drawn on. */
const STATUS_KEY = "quest-budget";

/** What keeps the session on its quest's budget. */
export interface BudgetKeeper {
	/**
	 * Draw on the budget the loaded quest names, if it changed. With
	 * `again`, ask the providers even when it didn't: naming a budget
	 * once more is how a person takes up one whose file they just wrote.
	 */
	keep(ctx: ExtensionContext, options?: { again?: boolean }): Promise<void>;
}

/** Host budget providers and keep the session on its quest's budget. */
export function keepQuestBudget(
	pi: ExtensionAPI,
	state: QuestState,
): BudgetKeeper {
	const host = hostBudgets(pi.events);
	/** The name last drawn on or asked for, null for none. */
	let wanted: string | null | undefined;
	/** Bumped on every ask, so an answer overtaken by another is dropped. */
	let asking = 0;
	/** Names already said to be undrawable, so each is said once. */
	const told = new Set<string>();
	let last: ExtensionContext | undefined;
	/** The ask still on its way, so a second keep can wait on it. */
	let pending: Promise<void> = Promise.resolve();

	const keep = async (ctx: ExtensionContext, again = false) => {
		last = ctx;
		const name = state.questId
			? (budgetInRecord(state.questsRoot, state.questId)?.name ?? null)
			: null;
		if (name === wanted && !again) return pending;
		wanted = name;
		const ask = ++asking;
		pending = settle(ctx, name, ask);
		return pending;
	};

	const settle = async (
		ctx: ExtensionContext,
		name: string | null,
		ask: number,
	) => {
		if (name === null) {
			liftBudget(process.env);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			recordDrawn(pi, ctx);
			return;
		}
		const drawing = await host.draw(name);
		if (ask !== asking) return;
		if (drawing.kind === "drawn") {
			layBudget(process.env, { name, label: drawing.label, env: drawing.env });
			told.delete(name);
			ctx.ui.setStatus(STATUS_KEY, statusOf(name, drawing.label, ctx));
			recordDrawn(pi, ctx, drawing);
			return;
		}
		liftBudget(process.env);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		recordDrawn(pi, ctx);
		if (told.has(name)) return;
		told.add(name);
		ctx.ui.notify(undrawable(name, drawing), "warning");
	};

	// A provider that registers late may know the name nothing did.
	host.onRegistered(() => {
		if (last && typeof wanted === "string") void keep(last, true);
	});

	return { keep: (ctx, options) => keep(ctx, options?.again ?? false) };
}

/**
 * Write the budget this session now draws on into its log, unless the
 * last entry on its branch already says it. It is read back from the
 * environment, so a budget inherited from the process that started
 * this one is what's written when this session lays none of its own.
 */
function recordDrawn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	drawing?: { readonly provider: string; readonly label: string },
): void {
	const name = budgetDrawnOn(process.env);
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	if (lastRecorded(branch) === name) return;
	const record: BudgetRecord =
		drawing && name !== null
			? { v: 1, name, label: drawing.label, provider: drawing.provider }
			: { v: 1, name };
	pi.appendEntry(BUDGET_ENTRY, record);
}

function statusOf(name: string, label: string, ctx: ExtensionContext): string {
	const said =
		label && label !== name ? `budget ${name} (${label})` : `budget ${name}`;
	return ctx.ui.theme.fg("muted", said);
}

/** Why a budget could not be drawn on, in words for the person. */
export function undrawable(
	name: string,
	drawing: Exclude<BudgetDrawing, { kind: "drawn" }>,
): string {
	if (drawing.kind === "unavailable") {
		return `Budget ${name} can't be drawn on yet (${drawing.provider}): ${drawing.reason} Model calls use the session's default until then.`;
	}
	return drawing.asked.length === 0
		? `No budget provider is installed, so budget ${name} means nothing yet; model calls use the session's default.`
		: `No budget provider knows ${name} (asked ${drawing.asked.join(", ")}), so model calls use the session's default.`;
}
