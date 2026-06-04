import { describe, expect, it } from "vitest";
import { findIdsWithRelation } from "../../../lib/internal/quest/id";

describe("findIdsWithRelation", () => {
	it("marks a bare id as a reference", () => {
		const got = findIdsWithRelation(
			"See also QEST-20260603-AAA111 for context.",
		);
		expect(got).toEqual([
			{ id: "QEST-20260603-AAA111", relation: "reference" },
		]);
	});

	it("marks an id preceded by the \u2192 sigil as produced", () => {
		const got = findIdsWithRelation(
			"- [ ] Synthesize findings \u2192 BRIF-20260605-CCC333",
		);
		expect(got).toEqual([{ id: "BRIF-20260605-CCC333", relation: "produced" }]);
	});

	it("upgrades a duplicate id when one occurrence carries the sigil", () => {
		const text = [
			"Earlier we touched on PLAN-20260603-XXXYYY in passing.",
			"- [ ] Draft the plan \u2192 PLAN-20260603-XXXYYY",
		].join("\n");
		const got = findIdsWithRelation(text);
		expect(got).toEqual([{ id: "PLAN-20260603-XXXYYY", relation: "produced" }]);
	});

	it("treats text between the sigil and the id as a downgrade", () => {
		const got = findIdsWithRelation(
			"Some prose \u2192 some more text PLAN-20260603-ZZZWWW",
		);
		expect(got).toEqual([
			{ id: "PLAN-20260603-ZZZWWW", relation: "reference" },
		]);
	});

	it("walks past whitespace and newlines between the sigil and the id", () => {
		const got = findIdsWithRelation("Produced \u2192\n\tRSCH-20260604-DDD444");
		expect(got).toEqual([{ id: "RSCH-20260604-DDD444", relation: "produced" }]);
	});
});
