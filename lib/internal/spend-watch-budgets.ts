/**
 * Where each budget stands, as spend-watch keeps it.
 *
 * A budget is a named source of money a request draws on: a Claude
 * plan, an API key, a proxy's cap, a team's token. spend-watch knows
 * every budget the machine declares, which request each turn drew on,
 * and how near each budget's allowances stand, and says so through
 * `spend-watch budgets --json`. As with the bill, the command is the
 * contract and its files are never read, and any failure is no answer
 * rather than an error: most machines this package runs on have no
 * spend-watch, and the footer then says the budget's name alone.
 */

import type { Exec } from "../core/exec/index.ts";
import { isRecord } from "./record.ts";
import { SPEND_WATCH } from "./spend-watch.ts";

/** A sum of money, and how spend-watch writes it, e.g. "$1,232". */
export interface Amount {
	readonly dollars: number;
	readonly shown: string;
}

/** What a feed last said of an allowance. */
export type AllowanceState = "ok" | "notified" | "refused";

/** How much of a budget one window allows: a share, or dollars. */
export interface Allowance {
	readonly name: string;
	/** Its window in words, e.g. "5 h" or "the week". */
	readonly label: string;
	readonly unit: "share" | "dollars";
	/** How much of it is spent, from 0 to 1. */
	readonly used: number;
	/** A dollar allowance's amount and what's spent of it, in dollars. */
	readonly dollars?: { readonly spent: number; readonly allowance: number };
	/** Past this share, the allowance warns. */
	readonly warn?: number;
	/** When the window starts again, in milliseconds since the epoch. */
	readonly resets?: number;
	readonly state: AllowanceState;
	/** spend-watch's facts of it in words, those it said. */
	readonly said?: AllowanceSaid;
}

/**
 * An allowance's facts as spend-watch words them, so pi formats none:
 * where it warns ("at $36,000"), whose reading it is and when ("the AI
 * proxy at 14:05"), what its feed says beyond that it's within it
 * ("warned"), when an override of it ends and how it last changed.
 * Each is absent where spend-watch had nothing to say.
 */
export interface AllowanceSaid {
	readonly warns?: string;
	readonly read?: string;
	readonly state?: string;
	readonly ends?: string;
	readonly changed?: string;
}

/**
 * A budget's facts as spend-watch words them: whose money and what kind
 * ("the employer's money"), what it spent over each period, what a
 * plan's turns were worth at list, and how its feeds read.
 */
export interface BudgetSaid {
	readonly words?: string;
	readonly spent?: string;
	readonly worth?: string;
	readonly reading?: string;
}

/** One budget and where it stands. */
export interface BudgetStanding {
	readonly name: string;
	readonly label: string;
	/** plan, key, cap or team. */
	readonly kind: string;
	/** Whether it's the machine's default, drawn on when nothing names one. */
	readonly isDefault: boolean;
	/** The pi providers whose turns are always this budget's. */
	readonly providers: readonly string[];
	/** What it spent, by spend-watch's period words. */
	readonly spent: Readonly<Record<string, Amount>>;
	readonly allowances: readonly Allowance[];
	/** The nearest allowance's standing in its own unit, e.g. "62% of 5 h". */
	readonly standing: string;
	/** The nearest allowance's share, for ordering; absent with none. */
	readonly nearest?: number;
	/** spend-watch's facts of it in words, those it said. */
	readonly said?: BudgetSaid;
}

/** Every budget the machine declares, and the total across them. */
export interface Budgets {
	readonly at: string;
	/** The default budget's name. */
	readonly default?: string;
	/** All AI spend, billed dollars only, by period words. */
	readonly total: Readonly<Record<string, Amount>>;
	readonly budgets: readonly BudgetStanding[];
	/** The session asked about: its budget and what it spent there. */
	readonly session?: { readonly budget: string; readonly spent?: Amount };
}

/**
 * Ask spend-watch where every budget stands, and with `session` what
 * that session spent. Undefined when it isn't installed, fails, or
 * answers with something that isn't the budgets.
 */
export async function askBudgets(
	exec: Exec,
	session?: string,
): Promise<Budgets | undefined> {
	const args = [
		"budgets",
		"--json",
		...(session ? ["--session", session] : []),
	];
	const result = await exec(SPEND_WATCH, args);
	if (result.code !== 0) return undefined;
	try {
		return budgetsFrom(JSON.parse(result.stdout));
	} catch {
		// Output that isn't JSON is no answer, and the footer says the name alone.
		return undefined;
	}
}

/** Read parsed budgets, or undefined when they aren't. */
export function budgetsFrom(value: unknown): Budgets | undefined {
	if (!isRecord(value) || value.v !== 1 || typeof value.at !== "string") {
		return undefined;
	}
	if (!Array.isArray(value.budgets)) return undefined;
	const session = sessionFrom(value.session);
	return {
		at: value.at,
		...(typeof value.default === "string" ? { default: value.default } : {}),
		total: amountsFrom(value.total),
		budgets: value.budgets.flatMap((one) => {
			const read = budgetFrom(one);
			return read ? [read] : [];
		}),
		...(session ? { session } : {}),
	};
}

/** The budget a turn on `provider` draws on, when one claims it. */
export function claimantOf(
	budgets: Budgets,
	provider: string | undefined,
): BudgetStanding | undefined {
	if (provider === undefined) return undefined;
	return budgets.budgets.find((one) => one.providers.includes(provider));
}

function budgetFrom(value: unknown): BudgetStanding | undefined {
	if (!isRecord(value)) return undefined;
	const { name, label, kind, standing, nearest } = value;
	if (typeof name !== "string" || typeof standing !== "string") {
		return undefined;
	}
	return {
		name,
		label: typeof label === "string" ? label : name,
		kind: typeof kind === "string" ? kind : "",
		isDefault: value.default === true,
		providers: Array.isArray(value.providers)
			? value.providers.filter((one): one is string => typeof one === "string")
			: [],
		spent: amountsFrom(value.spent),
		allowances: Array.isArray(value.allowances)
			? value.allowances.flatMap((one) => {
					const read = allowanceFrom(one);
					return read ? [read] : [];
				})
			: [],
		standing,
		...(isMeasure(nearest) ? { nearest } : {}),
		...budgetSaidFrom(value),
	};
}

/**
 * A budget's words, from its `words` and its `said`, which spend-watch
 * writes from schema 1's additions of 8 Nov 2026; an older spend-watch
 * says none, and the report then says what it said before.
 */
function budgetSaidFrom(value: Record<string, unknown>): {
	said?: BudgetSaid;
} {
	const said = isRecord(value.said) ? value.said : {};
	return saidOf(["words", "spent", "worth", "reading"], {
		...said,
		words: value.words,
	});
}

function allowanceSaidFrom(value: Record<string, unknown>): {
	said?: AllowanceSaid;
} {
	if (!isRecord(value.said)) return {};
	return saidOf(["warns", "read", "state", "ends", "changed"], value.said);
}

/** Only the facts given in words, or none at all when there are none. */
function saidOf<Key extends string>(
	keys: readonly Key[],
	facts: Record<string, unknown>,
): { said?: Partial<Record<Key, string>> } {
	const said: Partial<Record<Key, string>> = {};
	for (const key of keys) {
		const fact = facts[key];
		if (typeof fact === "string" && fact !== "") said[key] = fact;
	}
	return keys.some((key) => key in said) ? { said } : {};
}

function allowanceFrom(value: unknown): Allowance | undefined {
	if (!isRecord(value) || typeof value.name !== "string") return undefined;
	const unit = value.unit === "share" ? "share" : "dollars";
	const dollars =
		unit === "dollars" &&
		isMeasure(value.spent) &&
		typeof value.allowance === "number" &&
		value.allowance > 0
			? { spent: value.spent, allowance: value.allowance }
			: undefined;
	const used =
		unit === "share"
			? value.used
			: dollars && dollars.spent / dollars.allowance;
	if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
		return undefined;
	}
	const resets =
		typeof value.resets === "string" ? Date.parse(value.resets) : Number.NaN;
	return {
		name: value.name,
		label: typeof value.label === "string" ? value.label : value.name,
		unit,
		used,
		...(dollars ? { dollars } : {}),
		...(isMeasure(value.warn) ? { warn: value.warn } : {}),
		...(Number.isFinite(resets) ? { resets } : {}),
		state:
			value.state === "notified" || value.state === "refused"
				? value.state
				: "ok",
		...allowanceSaidFrom(value),
	};
}

function sessionFrom(value: unknown): Budgets["session"] {
	if (!isRecord(value) || typeof value.budget !== "string") return undefined;
	const spent = amountFrom(value.spent);
	return { budget: value.budget, ...(spent ? { spent } : {}) };
}

function amountsFrom(value: unknown): Record<string, Amount> {
	if (!isRecord(value)) return {};
	const amounts: Record<string, Amount> = {};
	for (const [period, raw] of Object.entries(value)) {
		const amount = amountFrom(raw);
		if (amount) amounts[period] = amount;
	}
	return amounts;
}

function amountFrom(value: unknown): Amount | undefined {
	if (!isRecord(value)) return undefined;
	const { dollars, shown } = value;
	if (
		typeof dollars !== "number" ||
		!Number.isFinite(dollars) ||
		typeof shown !== "string"
	) {
		return undefined;
	}
	return { dollars, shown };
}

/** A share or a sum: a finite number, never below nothing. */
function isMeasure(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
