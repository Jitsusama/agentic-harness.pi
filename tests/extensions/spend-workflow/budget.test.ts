/**
 * Which budget a session spends, and what the footer says of it: the
 * budget that claims the provider, else the one drawn by name, else the
 * machine's default, which speaks only once it warns.
 */
import { describe, expect, it } from "vitest";
import {
	budgetMark,
	budgetReport,
	nearest,
	type SessionBudget,
	sessionBudget,
	toneOf,
} from "../../../extensions/spend-workflow/budget.ts";
import type {
	Allowance,
	BudgetStanding,
	Budgets,
} from "../../../lib/internal/spend-watch-budgets.ts";

const RESETS = Date.parse("2026-11-07T21:30:00Z");
const clock = (at: number) => new Date(at).toISOString().slice(11, 16);

function allowance(over: Partial<Allowance> = {}): Allowance {
	return {
		name: "weekly",
		label: "the week",
		unit: "dollars",
		used: 0.46,
		warn: 0.9,
		resets: RESETS,
		state: "ok",
		...over,
	};
}

function budget(over: Partial<BudgetStanding> = {}): BudgetStanding {
	return {
		name: "proxy",
		label: "Your proxy cap",
		kind: "cap",
		isDefault: true,
		providers: [],
		spent: {},
		allowances: [allowance()],
		standing: "$18,400 of $40,000",
		nearest: 0.46,
		...over,
	};
}

const CLAUDE = budget({
	name: "claude",
	label: "Claude Pro",
	kind: "plan",
	isDefault: false,
	providers: ["claude-code"],
	allowances: [
		allowance({
			name: "five-hours",
			label: "5 h",
			unit: "share",
			used: 0.2,
			warn: 0.7,
		}),
	],
	standing: "20% of 5 h",
});
/** A team's token, with no allowance, so nothing to be near. */
const { nearest: _none, ...DELTA } = budget({
	name: "delta",
	label: "Delta team token",
	kind: "team",
	isDefault: false,
	allowances: [],
	standing: "$12 today",
});

function budgets(...all: BudgetStanding[]): Budgets {
	return { at: "2026-11-07T10:00:00Z", total: {}, budgets: all };
}

const MACHINE = budgets(budget(), CLAUDE, DELTA);

describe("the budget a session spends", () => {
	it("is the one that claims its provider, whatever it draws by name", () => {
		expect(
			sessionBudget({
				budgets: MACHINE,
				provider: "claude-code",
				drawn: "delta",
			}),
		).toMatchObject({ name: "claude", chosen: true });
	});

	it("is the one drawn by name, under a provider nobody claims", () => {
		expect(
			sessionBudget({
				budgets: MACHINE,
				provider: "anthropic",
				drawn: "delta",
			}),
		).toEqual({
			name: "delta",
			chosen: true,
			allowances: [],
			standing: "$12 today",
		});
	});

	it("is the machine's default when it draws on none, and not chosen", () => {
		expect(
			sessionBudget({ budgets: MACHINE, provider: "anthropic" }),
		).toMatchObject({
			name: "proxy",
			chosen: false,
		});
	});

	it("is the drawn name alone without spend-watch, and nothing else", () => {
		expect(sessionBudget({ drawn: "delta" })).toEqual({
			name: "delta",
			chosen: true,
			allowances: [],
		});
		expect(sessionBudget({ provider: "anthropic" })).toBeUndefined();
	});

	it("takes a plan's windows from what Claude Code last said", () => {
		const said = sessionBudget({
			budgets: MACHINE,
			provider: "claude-code",
			plan: {
				fiveHour: { used: 0.84, resets: RESETS },
				week: { used: 0.4 },
				stopped: false,
			},
		});
		expect(said?.name).toBe("claude");
		expect(said?.allowances).toEqual([
			{
				name: "five-hours",
				label: "5 h",
				unit: "share",
				used: 0.84,
				warn: 0.7,
				resets: RESETS,
				state: "ok",
			},
			{
				name: "week",
				label: "the week",
				unit: "share",
				used: 0.4,
				state: "ok",
			},
		]);
	});

	it("calls the plan claude, and marks the fuller window refused when stopped", () => {
		const said = sessionBudget({
			provider: "claude-code",
			plan: { fiveHour: { used: 1 }, week: { used: 0.5 }, stopped: true },
		});
		expect(said?.name).toBe("claude");
		expect(said?.allowances.map((one) => one.state)).toEqual(["refused", "ok"]);
	});
});

describe("the footer's mark", () => {
	const chosen = (
		allowances: Allowance[],
		standing?: string,
	): SessionBudget => ({
		name: "delta",
		chosen: true,
		allowances,
		...(standing ? { standing } : {}),
	});

	it("is the mark alone while the budget is calm", () => {
		const calm = chosen([
			allowance({ unit: "share", used: 0.62, label: "5 h", warn: 0.8 }),
		]);
		expect(budgetMark(calm)).toEqual({ tone: "dim" });
		expect(budgetMark(chosen([allowance()], "$184 of $300"))).toEqual({
			tone: "dim",
		});
	});

	it("adds the share used only past its warning", () => {
		expect(
			budgetMark(
				chosen([
					allowance({ unit: "share", used: 0.84, label: "5 h", warn: 0.8 }),
				]),
			),
		).toEqual({ tone: "warning", percent: 84 });
		expect(budgetMark(chosen([allowance({ used: 1.02 })]))).toEqual({
			tone: "error",
			percent: 102,
		});
	});

	it("marks a chosen budget with nothing known", () => {
		expect(budgetMark(chosen([]))).toEqual({ tone: "dim" });
	});

	it("keeps the default quiet until it warns", () => {
		const fallback = {
			name: "proxy",
			chosen: false,
			allowances: [allowance()],
		};
		expect(budgetMark(fallback)).toBeUndefined();
		expect(budgetMark({ ...fallback, allowances: [] })).toBeUndefined();
		expect(
			budgetMark({
				...fallback,
				allowances: [allowance({ used: 0.95 })],
				standing: "$38,000 of $40,000",
			})?.tone,
		).toBe("warning");
	});
});

describe("the report", () => {
	const when = (at: number) => clock(at);

	it("says all AI spend first, then each budget nearest its end first", () => {
		const lines = budgetReport({
			budgets: {
				...budgets(
					DELTA,
					budget({
						allowances: [
							allowance({ dollars: { spent: 18400, allowance: 40000 } }),
						],
					}),
					budget({ ...CLAUDE, nearest: 0.9 }),
				),
				total: {
					today: { dollars: 413, shown: "$413" },
					"this month": { dollars: 9100, shown: "$9,100" },
				},
			},
			session: { name: "delta", chosen: true, allowances: [] },
			sessionSpent: { dollars: 3.1, shown: "$3.10" },
			listPrice: 9,
			when,
		});
		expect(
			lines.filter((line) => line.face === "heading").map((line) => line.text),
		).toEqual([
			"All AI Spend",
			"claude  Claude Pro",
			"proxy  Your proxy cap, the default",
			"delta  Delta team token",
			"This Session",
		]);
		expect(lines[1]?.text).toBe("$9,100 this month \u00b7 $413 today");
		expect(lines[2]?.text).toBe("billed spend");
		expect(lines.map((line) => line.text)).toContain(
			`$18,400 of $40,000, resets ${clock(RESETS)}`,
		);
		expect(lines.at(-1)?.text).toBe("$3.10 billed, on delta");
	});

	it("says every fact spend-watch put in words, each under what it's of", () => {
		const lines = budgetReport({
			budgets: budgets(
				budget({
					standing: "$18,400 of $40,000",
					said: {
						words: "the employer's money",
						spent: "$412 today \u00b7 $9,100 this month",
						reading: "reading fine",
					},
					allowances: [
						allowance({
							dollars: { spent: 18400, allowance: 40000 },
							said: {
								state: "warned",
								read: "the AI proxy at 10:00",
								warns: "at $36,000",
								ends: "Wed 2 Dec \u00b7 a guess",
								changed: "raised $30,000 to $40,000 \u00b7 Thu 11:31",
							},
						}),
					],
				}),
			),
			listPrice: 1,
			when,
		});
		const proxy = lines.findIndex((line) => line.text.startsWith("proxy"));
		expect(lines.slice(proxy, proxy + 11).map((line) => line.text)).toEqual([
			"proxy  Your proxy cap, the default",
			"$18,400 of $40,000",
			"the employer's money",
			"spent $412 today \u00b7 $9,100 this month",
			"feed reading fine",
			`$18,400 of $40,000, resets ${clock(RESETS)}`,
			"  feed says warned",
			"  read by the AI proxy at 10:00",
			"  warns at $36,000",
			"  override ends Wed 2 Dec \u00b7 a guess",
			"  raised $30,000 to $40,000 \u00b7 Thu 11:31",
		]);
	});

	it("leaves out a budget's spend where its standing already says it", () => {
		const lines = budgetReport({
			budgets: budgets(
				budget({
					allowances: [],
					standing: "about $911 this month",
					said: { spent: "about $911 this month" },
				}),
			),
			listPrice: 1,
			when,
		});
		expect(lines.map((line) => line.text)).not.toContain(
			"spent about $911 this month",
		);
	});

	it("says what it can without spend-watch, and that the figure is list price", () => {
		const lines = budgetReport({
			session: { name: "delta", chosen: true, allowances: [] },
			listPrice: 2.5,
			when,
		});
		expect(lines[0]?.text).toBe("$2.50 at list prices, on delta");
		expect(lines[1]?.text).toContain("spend-watch isn't here");
	});
});

describe("an allowance's tone", () => {
	it("warns past its feed's warning, else past four fifths", () => {
		expect(toneOf(allowance({ used: 0.85 }))).toBe("dim");
		expect(toneOf(allowance({ used: 0.9 }))).toBe("warning");
		const { warn: _warn, ...unwarned } = allowance({ used: 0.8 });
		expect(toneOf(unwarned)).toBe("warning");
		expect(toneOf(allowance({ state: "notified" }))).toBe("warning");
	});

	it("is an error once spent or refused", () => {
		expect(toneOf(allowance({ used: 1 }))).toBe("error");
		expect(toneOf(allowance({ state: "refused" }))).toBe("error");
	});

	it("is the fullest allowance's", () => {
		const full = allowance({ name: "five-hours", used: 0.9 });
		expect(nearest([allowance(), full])).toBe(full);
		expect(nearest([])).toBeUndefined();
	});
});
