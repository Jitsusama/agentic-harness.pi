/**
 * Where each budget stands, read from `spend-watch budgets --json`, and
 * no answer at all wherever spend-watch can't give one.
 */
import { describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import {
	askBudgets,
	budgetsFrom,
	claimantOf,
} from "../../../lib/internal/spend-watch-budgets.ts";

/** spend-watch's answer as the contract writes it, 7 Nov 2026. */
const ANSWER = {
	v: 1,
	at: "2026-11-07T10:00:00Z",
	default: "proxy",
	total: {
		today: { dollars: 412.5, shown: "$413" },
		"this month": { dollars: 9100, shown: "$9,100" },
		words: "billed spend",
	},
	budgets: [
		{
			name: "claude",
			label: "Claude Pro",
			kind: "plan",
			default: false,
			providers: ["claude-code"],
			spent: { today: { dollars: 0, shown: "$0" } },
			allowances: [
				{
					name: "five-hours",
					label: "5 h",
					unit: "share",
					used: 0.62,
					warn: 0.8,
					resets: "2026-11-07T14:20:00Z",
					state: "ok",
				},
			],
			standing: "62% of 5 h",
			nearest: 0.62,
		},
		{
			name: "proxy",
			label: "Your proxy cap",
			kind: "cap",
			default: true,
			providers: [],
			allowances: [
				{
					name: "weekly",
					label: "the week",
					unit: "dollars",
					allowance: 40000,
					spent: 18400,
					warn: 0.9,
					state: "notified",
					said: {
						window: "a week",
						warns: "at $36,000",
						resets: "",
						ends: "Wed 2 Dec \u00b7 a guess",
						changed: "",
						read: "the AI proxy at 10:00",
						state: "warned",
					},
				},
			],
			standing: "$18,400 of $40,000",
			nearest: 0.46,
			words: "the employer's money",
			said: {
				spent: "$412 today \u00b7 $9,100 this month",
				worth: "",
				reading: "reading fine",
			},
		},
	],
	session: {
		id: "s1",
		budget: "proxy",
		spent: { dollars: 3.1, shown: "$3.10" },
	},
};

function answering(code: number, stdout: string): Exec {
	return async () => ({ code, stdout, stderr: "" });
}

describe("where each budget stands", () => {
	it("reads every budget, its allowances in their own units", () => {
		const read = budgetsFrom(ANSWER);
		expect(read?.default).toBe("proxy");
		expect(read?.total).toEqual({
			today: { dollars: 412.5, shown: "$413" },
			"this month": { dollars: 9100, shown: "$9,100" },
		});
		expect(read?.budgets.map((one) => [one.name, one.isDefault])).toEqual([
			["claude", false],
			["proxy", true],
		]);
		expect(read?.budgets[0]?.allowances[0]).toEqual({
			name: "five-hours",
			label: "5 h",
			unit: "share",
			used: 0.62,
			warn: 0.8,
			resets: Date.parse("2026-11-07T14:20:00Z"),
			state: "ok",
		});
	});

	it("measures a dollar allowance by what it spent of it", () => {
		const weekly = budgetsFrom(ANSWER)?.budgets[1]?.allowances[0];
		expect(weekly?.used).toBeCloseTo(0.46);
		expect(weekly?.state).toBe("notified");
	});

	it("keeps the facts spend-watch put in words, and none it left empty", () => {
		const proxy = budgetsFrom(ANSWER)?.budgets[1];
		expect(proxy?.said).toEqual({
			words: "the employer's money",
			spent: "$412 today \u00b7 $9,100 this month",
			reading: "reading fine",
		});
		expect(proxy?.allowances[0]?.said).toEqual({
			warns: "at $36,000",
			read: "the AI proxy at 10:00",
			state: "warned",
			ends: "Wed 2 Dec \u00b7 a guess",
		});
	});

	it("says no words of a budget from a spend-watch that wrote none", () => {
		const claude = budgetsFrom(ANSWER)?.budgets[0];
		expect(claude?.said).toBeUndefined();
		expect(claude?.allowances[0]?.said).toBeUndefined();
	});

	it("says the session asked about", () => {
		expect(budgetsFrom(ANSWER)?.session).toEqual({
			budget: "proxy",
			spent: { dollars: 3.1, shown: "$3.10" },
		});
	});

	it("gives a claimed provider's turns to the budget that claims it", () => {
		const read = budgetsFrom(ANSWER);
		expect(read && claimantOf(read, "claude-code")?.name).toBe("claude");
		expect(read && claimantOf(read, "anthropic")).toBeUndefined();
		expect(read && claimantOf(read, undefined)).toBeUndefined();
	});

	it("refuses another version, and drops what it can't read", () => {
		expect(budgetsFrom({ ...ANSWER, v: 2 })).toBeUndefined();
		expect(budgetsFrom({ v: 1, at: "x" })).toBeUndefined();
		const odd = budgetsFrom({
			...ANSWER,
			budgets: [
				{ name: "nameless standing" },
				{
					name: "team",
					standing: "$4 today",
					allowances: [{ name: "bad", unit: "share", used: -1 }],
				},
			],
		});
		expect(odd?.budgets).toEqual([
			{
				name: "team",
				label: "team",
				kind: "",
				isDefault: false,
				providers: [],
				spent: {},
				allowances: [],
				standing: "$4 today",
			},
		]);
	});
});

describe("asking spend-watch", () => {
	it("asks for one session's spend when given one", async () => {
		const asked: string[][] = [];
		const exec: Exec = async (_command, args) => {
			asked.push([...args]);
			return { code: 0, stdout: JSON.stringify(ANSWER), stderr: "" };
		};
		expect((await askBudgets(exec, "s1"))?.session?.budget).toBe("proxy");
		expect(await askBudgets(exec)).toBeDefined();
		expect(asked).toEqual([
			["budgets", "--json", "--session", "s1"],
			["budgets", "--json"],
		]);
	});

	it("is no answer where spend-watch fails or says nonsense", async () => {
		expect(await askBudgets(answering(127, ""))).toBeUndefined();
		expect(await askBudgets(answering(0, "not json"))).toBeUndefined();
	});
});
