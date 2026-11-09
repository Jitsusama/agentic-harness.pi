/**
 * The loaded quest's budget, laid over this session's environment.
 *
 * Quest-workflow hosts the budget providers (lib/budget/host.ts), since
 * it is what knows which quest a session is on. When the session
 * starts and after every quest action, it works out the budget the
 * loaded quest draws on (its own, or its nearest ancestor's), asks
 * the providers what that name means and lays the answer over
 * the session's environment, putting back what was there when the quest draws on
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
 * session's log says the budget drawn on (lib/budget/record.ts) each
 * time it changes, so whatever prices the log knows whose money each
 * request spent, and the bus says it each time it settles, for
 * spend-workflow's footer item, which tells it with its standing. Nothing of it goes
 * into the prompt: what a session bills is the person's to see, not
 * the model's to reason about.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	layBudget,
	liftBudget,
	processOverlay,
} from "../../lib/budget/environment.ts";
import { type BudgetDrawing, hostBudgets } from "../../lib/budget/host.ts";
import {
	BUDGET_ENTRY,
	BUDGET_SETTLED,
	type BudgetRecord,
	type BudgetSettled,
	budgetDrawnOn,
	lastRecorded,
} from "../../lib/budget/record.ts";
import { sessionEnv } from "../../lib/core/session/index.ts";
import { budgetInRecord } from "../../lib/internal/quest/budget.ts";
import type { QuestState } from "./state.ts";

/** What keeps the session on its quest's budget. */
export interface BudgetKeeper {
	/**
	 * Draw on the budget the loaded quest names, if it changed. With
	 * `again`, ask the providers even when it didn't: naming a budget
	 * once more is how a person takes up one whose file they just wrote.
	 */
	keep(ctx: ExtensionContext, options?: { again?: boolean }): Promise<void>;
	/**
	 * The session has ended or been replaced: forget its context, so an
	 * answer still on its way acts for nothing. A provider has seconds to
	 * answer and the ask at start is awaited by nobody, so a reload or a
	 * rollover can land in between; the context then throws on every
	 * read, and the environment is the next load's. A later `keep` takes
	 * a session up again.
	 */
	forget(): void;
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
			liftBudget(sessionEnv(ctx), processOverlay(ctx));
			recordDrawn(pi, ctx);
			return;
		}
		const drawing = await host.draw(name);
		if (ask !== asking) return;
		if (drawing.kind === "drawn") {
			layBudget(
				sessionEnv(ctx),
				{ name, label: drawing.label, env: drawing.env },
				processOverlay(ctx),
			);
			told.delete(name);
			recordDrawn(pi, ctx, drawing);
			return;
		}
		liftBudget(sessionEnv(ctx), processOverlay(ctx));
		recordDrawn(pi, ctx);
		if (told.has(name)) return;
		told.add(name);
		ctx.ui.notify(undrawable(name, drawing), "warning");
	};

	// A provider that registers late may know the name nothing did.
	host.onRegistered(() => {
		if (!last || typeof wanted !== "string") return;
		keep(last, true).catch(() => {
			// Nothing awaits this ask, and an unwatched rejection ends pi;
			// the next keep, before the next model call, asks again.
		});
	});

	const forget = () => {
		last = undefined;
		// Asked again in full by the next session's first keep, and any
		// answer still on its way is overtaken, so it lays nothing.
		wanted = undefined;
		asking++;
	};

	return {
		keep: (ctx, options) => keep(ctx, options?.again ?? false),
		forget,
	};
}

/**
 * Write the budget this session now draws on into its log, unless the
 * last entry on its branch already says it. It is read back from the
 * environment, so a budget inherited from the process that started
 * this one is what's written when this session lays none of its own.
 * The bus hears it every time, written or not, since a footer that
 * loaded after the entry was written still needs telling.
 */
function recordDrawn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	drawing?: { readonly provider: string; readonly label: string },
): void {
	const name = budgetDrawnOn(sessionEnv(ctx).snapshot());
	const settled: BudgetSettled = { name };
	pi.events.emit(BUDGET_SETTLED, settled);
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	if (lastRecorded(branch) === name) return;
	const record: BudgetRecord =
		drawing && name !== null
			? { v: 1, name, label: drawing.label, provider: drawing.provider }
			: { v: 1, name };
	pi.appendEntry(BUDGET_ENTRY, record);
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
