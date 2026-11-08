/**
 * The session's budget on the footer, and every budget in `/budget`.
 *
 * A budget is whose money a request spends: a Claude plan, the AI
 * proxy's cap, a team's token. The footer says the one this session
 * draws on and how near its nearest allowance stands, in that
 * allowance's own unit ("62% of 5 h", "$184 of $300"), never converted:
 * a share of a plan's window has no price. spend-watch knows every
 * budget's standing; under the Claude Code provider the plan's windows
 * come fresher from what the provider said after the last turn, so the
 * figure moves with each turn rather than each time spend-watch is
 * asked.
 *
 * The item follows the design's ruling (VKCF3Z, 6 Nov 2026): one mark,
 * AI spend's, coloured by the nearest allowance, the words always dim.
 * A budget the session chose (its quest's, an inherited one, or the one
 * that claims its provider) always shows; the machine's default shows
 * only once it warns, since it is what every session spends and saying
 * so all day says nothing.
 */

import {
	PLAN_PROVIDER,
	type PlanUse,
	type PlanWindow,
} from "../../lib/internal/claude-plan.ts";
import type {
	Allowance,
	Amount,
	BudgetStanding,
	Budgets,
} from "../../lib/internal/spend-watch-budgets.ts";
import { claimantOf } from "../../lib/internal/spend-watch-budgets.ts";

/** The name a plan's budget goes by when spend-watch doesn't say one. */
const PLAN_NAME = "claude";

/** Past this share an allowance warns, when its feed sets no warning. */
export const WARN_AT = 0.8;

/** How a footer mark is coloured, as the theme names it. */
export type BudgetTone = "dim" | "warning" | "error";

/** The budget a session draws on, as the footer tells it. */
export interface SessionBudget {
	readonly name: string;
	/** Chosen for this session, rather than the machine's default. */
	readonly chosen: boolean;
	readonly allowances: readonly Allowance[];
	/** spend-watch's words for the nearest allowance, where it said them. */
	readonly standing?: string;
}

/** What the session's budget is worked out from. */
export interface BudgetInputs {
	/** spend-watch's answer, absent where it isn't installed. */
	readonly budgets?: Budgets;
	/** The provider the session's model is reached through. */
	readonly provider?: string;
	/** The budget the session draws on by name (`PI_BUDGET`). */
	readonly drawn?: string | null;
	/** The plan's windows as the provider last said them. */
	readonly plan?: PlanUse;
}

/**
 * The budget this session's next turn spends: the one that claims its
 * provider, else the one it draws on by name, else the machine's
 * default, as spend-watch attributes a turn. Undefined when nothing is
 * known of any.
 */
export function sessionBudget(inputs: BudgetInputs): SessionBudget | undefined {
	const { budgets, provider, drawn, plan } = inputs;
	const claimant = budgets ? claimantOf(budgets, provider) : undefined;
	if (provider === PLAN_PROVIDER && plan) {
		return {
			name: claimant?.name ?? PLAN_NAME,
			chosen: true,
			allowances: planAllowances(plan, claimant),
		};
	}
	if (claimant) return told(claimant, true);
	if (drawn) {
		const known = budgets?.budgets.find((one) => one.name === drawn);
		return known
			? told(known, true)
			: { name: drawn, chosen: true, allowances: [] };
	}
	const fallback = budgets?.budgets.find((one) => one.isDefault);
	return fallback ? told(fallback, false) : undefined;
}

/**
 * The footer's words for a budget and the tone its mark takes, or
 * undefined while it has nothing to say: a default budget well within
 * its allowances.
 */
export function budgetLine(
	budget: SessionBudget,
	clock: (at: number) => string,
): { tone: BudgetTone; text: string } | undefined {
	const near = nearest(budget.allowances);
	const tone = near ? toneOf(near) : "dim";
	if (!budget.chosen && tone === "dim") return undefined;
	// With no allowance, spend-watch's standing is what it spent lately.
	const standing = near ? standingOf(near, budget.standing) : budget.standing;
	const words = standing ? `${budget.name} ${standing}` : budget.name;
	const resets =
		tone !== "dim" && near?.resets !== undefined
			? ` · resets ${clock(near.resets)}`
			: "";
	return { tone, text: `${words}${resets}` };
}

/** The allowance nearest its end, by share. */
export function nearest(
	allowances: readonly Allowance[],
): Allowance | undefined {
	let found: Allowance | undefined;
	for (const one of allowances) {
		if (!found || one.used > found.used) found = one;
	}
	return found;
}

/** The mark's tone: refused or spent is an error, past warning a warning. */
export function toneOf(allowance: Allowance): BudgetTone {
	if (allowance.state === "refused" || allowance.used >= 1) return "error";
	if (allowance.state === "notified" || allowance.used >= warnOf(allowance)) {
		return "warning";
	}
	return "dim";
}

/** A share in its window's words: "62% of 5 h". */
export function shareOf(allowance: Allowance): string {
	return `${percentOf(allowance)} of ${allowance.label}`;
}

/** What `/budget` is told, beyond what spend-watch said. */
export interface ReportInputs {
	readonly budgets?: Budgets;
	/** The budget this session spends, as the footer has it. */
	readonly session?: SessionBudget;
	/** What spend-watch says this session spent under its budget. */
	readonly sessionSpent?: Amount;
	/** The ledger's list-price figure for this session, in dollars. */
	readonly listPrice: number;
	/** When an allowance starts again, in words: "14:20", "Mon 09:00". */
	readonly when: (at: number) => string;
}

/** One line of the report, and how it reads. */
export interface ReportLine {
	readonly text: string;
	/** A heading's line, a quiet one, or the body's. */
	readonly face: "heading" | "dim" | "text";
	/** The tone of a budget's mark, on the lines that carry one. */
	readonly tone?: BudgetTone;
}

/** Periods the total says, the month first, as the launcher's figure does. */
const TOTAL_PERIODS = ["this month", "7 days", "today"] as const;

/**
 * `/budget`'s report: all AI spend in billed dollars first, then every
 * budget nearest its end first, each allowance in its own unit with its
 * reset, then what this session spent and on which. Each budget and
 * allowance carries every fact spend-watch put in words, as the
 * launcher's drawers do, so the two never say different things: under
 * an allowance what its feed says, whose reading it is, where it warns,
 * when an override ends and how it last changed; under a budget whose
 * money it is, what it spent, a plan's worth at list and how its feed
 * reads. A spend-watch older than those words leaves them out. Without spend-watch
 * it says what it can: the session's budget by name and the ledger's
 * list-price figure, saying that it is one.
 */
export function budgetReport(inputs: ReportInputs): ReportLine[] {
	const { budgets, session, sessionSpent, listPrice, when } = inputs;
	if (!budgets) {
		return [
			{ face: "text", text: sessionWords(session, undefined, listPrice) },
			{
				face: "dim",
				text: "spend-watch isn't here to answer, so no budget's standing is known, and the figure is the ledger's at list prices.",
			},
		];
	}
	const total = TOTAL_PERIODS.flatMap((period) => {
		const amount = budgets.total[period];
		return amount ? [`${amount.shown} ${period}`] : [];
	});
	const lines: ReportLine[] = [
		{ face: "heading", text: "All AI Spend" },
		{
			face: "text",
			text: total.length > 0 ? total.join(" · ") : "nothing billed yet",
		},
		{ face: "dim", text: "billed spend" },
	];
	for (const one of byNearness(budgets.budgets)) {
		const near = nearest(one.allowances);
		const kind = one.isDefault ? `${one.label}, the default` : one.label;
		lines.push(
			{ face: "heading", text: `${one.name}  ${kind}` },
			{ face: "text", text: one.standing, tone: near ? toneOf(near) : "dim" },
			...budgetFacts(one).map(quiet),
		);
		for (const allowance of one.allowances) {
			const resets =
				allowance.resets !== undefined
					? `, resets ${when(allowance.resets)}`
					: "";
			lines.push({
				face: "dim",
				text: `${standingOf(allowance, undefined)}${resets}`,
				tone: toneOf(allowance),
			});
			// Indented under its allowance, past the mark's column.
			lines.push(
				...allowanceFacts(allowance).map((fact) => quiet(`  ${fact}`)),
			);
		}
	}
	lines.push(
		{ face: "heading", text: "This Session" },
		{ face: "text", text: sessionWords(session, sessionSpent, listPrice) },
	);
	return lines;
}

/**
 * A budget's facts beyond its standing: whose money it is, what it
 * spent where that says more than the standing, a plan's worth at list,
 * and how its feed reads.
 */
function budgetFacts(one: BudgetStanding): string[] {
	const said = one.said;
	if (!said) return [];
	return [
		said.words,
		said.spent && said.spent !== one.standing
			? `spent ${said.spent}`
			: undefined,
		said.worth && `worth at list ${said.worth}`,
		said.reading && `feed ${said.reading}`,
	].filter((fact): fact is string => fact !== undefined && fact !== "");
}

/**
 * An allowance's facts beyond its standing and reset, in the drawer's
 * order, what moves most first: what its feed says, whose reading it
 * is, where it warns, when an override ends and how it last changed.
 */
function allowanceFacts(allowance: Allowance): string[] {
	const said = allowance.said;
	if (!said) return [];
	return [
		said.state && `feed says ${said.state}`,
		said.read && `read by ${said.read}`,
		said.warns && `warns ${said.warns}`,
		said.ends && `override ends ${said.ends}`,
		said.changed,
	].filter((fact): fact is string => fact !== undefined && fact !== "");
}

function quiet(text: string): ReportLine {
	return { face: "dim", text };
}

function sessionWords(
	session: SessionBudget | undefined,
	spent: Amount | undefined,
	listPrice: number,
): string {
	const on = session ? `on ${session.name}` : "on the machine's default";
	const figure = spent
		? `${spent.shown} billed`
		: `$${listPrice.toFixed(2)} at list prices`;
	return `${figure}, ${on}`;
}

/** Budgets nearest their end first; those with no allowance last. */
function byNearness(all: readonly BudgetStanding[]): BudgetStanding[] {
	return [...all].sort((a, b) => (b.nearest ?? -1) - (a.nearest ?? -1));
}

function percentOf(allowance: Allowance): string {
	return `${Math.round(allowance.used * 100)}%`;
}

/**
 * An allowance's standing in its own unit: a share of its window, or
 * dollars of dollars, falling back on spend-watch's words for a dollar
 * allowance whose amounts it didn't say.
 */
function standingOf(near: Allowance, said: string | undefined): string {
	if (near.unit === "share") return shareOf(near);
	if (near.dollars) {
		return `${dollarsOf(near.dollars.spent)} of ${dollarsOf(near.dollars.allowance)}`;
	}
	return said ?? `${percentOf(near)} of ${near.label}`;
}

/** Whole dollars, as spend-watch writes them: "$18,400". */
function dollarsOf(amount: number): string {
	return `$${Math.round(amount).toLocaleString("en-CA")}`;
}

function warnOf(allowance: Allowance): number {
	return allowance.warn ?? WARN_AT;
}

function told(standing: BudgetStanding, chosen: boolean): SessionBudget {
	return {
		name: standing.name,
		chosen,
		allowances: standing.allowances,
		standing: standing.standing,
	};
}

/**
 * A plan's two windows as allowances, taking each window's warning from
 * spend-watch's where it knows the plan. A refused turn marks the fuller
 * window, since that is the one that stopped it.
 */
function planAllowances(
	plan: PlanUse,
	known: BudgetStanding | undefined,
): Allowance[] {
	const windows: [string, string, PlanWindow | undefined][] = [
		["five-hours", "5 h", plan.fiveHour],
		["week", "the week", plan.week],
	];
	const fuller = Math.max(plan.fiveHour?.used ?? 0, plan.week?.used ?? 0);
	return windows.flatMap(([name, label, window]) => {
		if (!window) return [];
		const warn = known?.allowances.find((one) => one.name === name)?.warn;
		const refused = plan.stopped && window.used >= fuller;
		return [
			{
				name,
				label,
				unit: "share" as const,
				used: window.used,
				...(warn !== undefined ? { warn } : {}),
				...(window.resets !== undefined ? { resets: window.resets } : {}),
				state: refused ? ("refused" as const) : ("ok" as const),
			},
		];
	});
}
