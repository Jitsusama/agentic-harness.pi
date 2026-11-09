import { describe, expect, it } from "vitest";
import {
	budgetOf,
	budgetSaid,
	isBudgetName,
} from "../../../../lib/internal/quest/budget.ts";

type Said = { budget?: unknown; parent: string | null };

function tree(quests: Record<string, Said>) {
	return (id: string) => {
		const quest = quests[id];
		if (!quest) return undefined;
		return {
			parent: quest.parent,
			_extra: quest.budget === undefined ? undefined : { budget: quest.budget },
		};
	};
}

describe("the budget a quest draws on", () => {
	it("is its own when it names one", () => {
		const read = tree({ A: { budget: "delta", parent: null } });

		expect(budgetOf("A", read)).toEqual({ name: "delta", from: "A" });
	});

	it("is its nearest ancestor's when it names none", () => {
		const read = tree({
			TOP: { budget: "delta", parent: null },
			MID: { budget: "aquifer", parent: "TOP" },
			LEAF: { parent: "MID" },
		});

		expect(budgetOf("LEAF", read)).toEqual({ name: "aquifer", from: "MID" });
	});

	it("is none where a quest says none, past what is above it", () => {
		const read = tree({
			TOP: { budget: "delta", parent: null },
			MINE: { budget: "none", parent: "TOP" },
			LEAF: { parent: "MINE" },
		});

		expect(budgetOf("LEAF", read)).toEqual({ name: null, from: "MINE" });
	});

	it("is undefined when nothing above names one, or a parent is missing", () => {
		expect(
			budgetOf(
				"LEAF",
				tree({ LEAF: { parent: "TOP" }, TOP: { parent: null } }),
			),
		).toBeUndefined();
		expect(
			budgetOf("LEAF", tree({ LEAF: { parent: "GONE" } })),
		).toBeUndefined();
	});

	it("stops at a loop of parents rather than walking forever", () => {
		const read = tree({ A: { parent: "B" }, B: { parent: "A" } });

		expect(budgetOf("A", read)).toBeUndefined();
	});

	it("passes over a value that can't be a name, as if unsaid", () => {
		const read = tree({
			TOP: { budget: "delta", parent: null },
			LEAF: { budget: "../etc/passwd", parent: "TOP" },
		});

		expect(budgetOf("LEAF", read)).toEqual({ name: "delta", from: "TOP" });
		expect(budgetSaid({ _extra: { budget: 7 } })).toBeUndefined();
	});
});

describe("a budget's name", () => {
	it("is letters, digits, dots, dashes and underscores, never a path", () => {
		expect(
			isBudgetName("delta-dev_1.2"),
			"letters, a dash, an underscore, a digit and a dot make a name",
		).toBe(true);
		expect(
			isBudgetName(".hidden"),
			"a name opening with a dot is refused",
		).toBe(false);
		expect(isBudgetName("a/b"), "a name holding a slash is refused").toBe(
			false,
		);
		expect(isBudgetName(""), "an empty name is refused").toBe(false);
		expect(
			isBudgetName("x".repeat(65)),
			"a name of 65 characters is refused",
		).toBe(false);
	});
});
