/**
 * The session's budget on the footer, kept current, and `/budget`.
 *
 * spend-watch is asked as the session starts, and again after a reply
 * at most once a minute, since it reads its whole history to answer
 * and nothing here polls. Between asks the item moves on what the
 * session itself learns: Claude Code's word on the plan after each
 * turn, a change of model, and quest-workflow settling the budget the
 * session draws on. Only a session with a person at it asks at all; a
 * subagent's spend is told in the session that started it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	BUDGET_SETTLED,
	type BudgetSettled,
	budgetDrawnOn,
} from "../../lib/budget/record.ts";
import type { Exec } from "../../lib/core/exec/index.ts";
import { sessionEnv } from "../../lib/core/session/index.ts";
import {
	lastPlanUse,
	type PlanUse,
	planUseOf,
} from "../../lib/internal/claude-plan.ts";
import { isRecord } from "../../lib/internal/record.ts";
import {
	askBudgets,
	type Budgets,
} from "../../lib/internal/spend-watch-budgets.ts";
import { footerMark, footerShare } from "../../lib/ui/footer-mark.ts";
import { view } from "../../lib/ui/panel.ts";
import {
	budgetMark,
	budgetReport,
	type ReportLine,
	sessionBudget,
} from "./budget.ts";

/** The footer's key for the budget item. */
const STATUS_KEY = "budget";

/** The least time between two asks of spend-watch after replies. */
const ASK_EVERY_MS = 60_000;

/** What the budget item needs from the rest of spend-workflow. */
export interface BudgetItemDeps {
	/** How spend-watch is run, with its deadline. */
	readonly exec: () => Exec;
	/** The ledger's list-price figure for this session, in dollars. */
	readonly listPrice: () => number;
}

/** Keep the budget item on the footer and register `/budget`. */
export function registerBudgetItem(
	pi: ExtensionAPI,
	deps: BudgetItemDeps,
): void {
	let budgets: Budgets | undefined;
	let plan: PlanUse | undefined;
	let provider: string | undefined;
	let drawn: string | null = null;
	let askedAt = Number.NEGATIVE_INFINITY;
	let asking: Promise<void> | undefined;
	let shown: ExtensionContext | undefined;
	/**
	 * What the footer was last told, so an unchanged item isn't redrawn;
	 * null until this session first tells it.
	 */
	let said: string | undefined | null = null;

	const current = () => sessionBudget({ budgets, provider, drawn, plan });

	/**
	 * The session's context while it has a person at it, else undefined.
	 * A context left behind by a reload or a session switch throws on
	 * every read, and a throw from an answer landing late is unwatched,
	 * so it would take pi down: on 7 November an install's reloads
	 * killed sessions that way. The load that replaced this one
	 * draws the footer, so a stale context is forgotten.
	 */
	const withUI = (): ExtensionContext | undefined => {
		try {
			return shown?.hasUI ? shown : undefined;
		} catch {
			shown = undefined;
			return undefined;
		}
	};

	const render = (): void => {
		const ctx = withUI();
		if (!ctx) return;
		const budget = current();
		const mark = budget && budgetMark(budget);
		try {
			const text = mark
				? footerShare("budget", mark.tone, ctx.ui.theme, mark.percent)
				: undefined;
			if (text === said) return;
			ctx.ui.setStatus(STATUS_KEY, text);
			said = text;
		} catch {
			// Stale since withUI looked: the replacing load draws it.
			shown = undefined;
		}
	};

	/** Ask spend-watch afresh, unless it was asked within the minute. */
	const ask = (always: boolean): Promise<void> => {
		if (asking) return asking;
		if (!always && Date.now() - askedAt < ASK_EVERY_MS)
			return Promise.resolve();
		askedAt = Date.now();
		asking = askBudgets(deps.exec())
			.then((answer) => {
				budgets = answer;
				render();
			})
			.catch(() => {
				// Nobody awaits this, and an unhandled rejection ends pi; a
				// failed ask leaves the footer as it was until the next.
			})
			.finally(() => {
				asking = undefined;
			});
		return asking;
	};

	pi.on("session_start", async (_event, ctx) => {
		shown = ctx;
		// What the footer holds after a reload isn't known, so the first
		// render writes whatever it says.
		said = null;
		if (!ctx.hasUI) return;
		provider = ctx.model?.provider;
		drawn = budgetDrawnOn(sessionEnv(ctx).snapshot());
		plan = lastPlanUse(ctx.sessionManager.getBranch());
		render();
		void ask(true);
	});

	pi.on("message_end", async (event) => {
		const said = planUseOf(event.message);
		if (!said) return;
		plan = said;
		render();
	});

	pi.on("model_select", async (event) => {
		provider = event.model.provider;
		render();
	});

	pi.on("agent_end", async () => {
		if (withUI()) void ask(false);
	});

	// A reload or a session switch leaves this load's context throwing.
	// pi drops its bus listeners only once every shutdown handler has
	// run, and an answer may still be on its way, so from here nothing
	// is drawn.
	pi.on("session_shutdown", async () => {
		shown = undefined;
	});

	pi.events.on(BUDGET_SETTLED, (data: unknown) => {
		if (!isSettled(data)) return;
		drawn = data.name;
		render();
	});

	pi.registerCommand("budget", {
		description:
			"Show every budget and where it stands, what this session spent and on which, and all AI spend.",
		handler: async (_args, ctx) => {
			const answer = await askBudgets(
				deps.exec(),
				ctx.sessionManager.getSessionId(),
			);
			if (answer) {
				budgets = answer;
				askedAt = Date.now();
				render();
			}
			const lines = budgetReport({
				...(answer ? { budgets: answer } : {}),
				...(current() ? { session: current() } : {}),
				...(answer?.session?.spent
					? { sessionSpent: answer.session.spent }
					: {}),
				listPrice: deps.listPrice(),
				when: dayAndTime,
			});
			await view(ctx, {
				title: "Budgets",
				content: (theme) => drawReport(lines, theme),
			});
		},
	});
}

/** The report's lines for a panel, a budget's figures marked in its tone. */
export function drawReport(
	lines: readonly ReportLine[],
	theme: Theme,
): string[] {
	const drawn = [""];
	for (const line of lines) {
		if (line.face === "heading") {
			if (drawn.length > 1) drawn.push("");
			drawn.push(`  ${theme.fg("toolTitle", theme.bold(line.text))}`);
			continue;
		}
		const mark = line.tone
			? `${footerMark("budget", line.tone, theme)} `
			: "  ";
		drawn.push(`    ${mark}${theme.fg(line.face, line.text)}`);
	}
	drawn.push("");
	return drawn;
}

function isSettled(data: unknown): data is BudgetSettled {
	return (
		isRecord(data) && (data.name === null || typeof data.name === "string")
	);
}

function hourMinute(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}

/** A reset in words: its time today, else its weekday and time. */
function dayAndTime(at: number): string {
	const date = new Date(at);
	const today = new Date().toDateString() === date.toDateString();
	const day = date.toLocaleDateString("en-CA", { weekday: "short" });
	return today ? hourMinute(at) : `${day} ${hourMinute(at)}`;
}
