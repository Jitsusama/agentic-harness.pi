import { describe, expect, it } from "vitest";
import { planDemotions } from "../../../lib/demote/index.js";

describe("planning a demotion", () => {
	it("names the tool, the size and a digest a caller can hand back later", () => {
		const [plan] = planDemotions([
			{ index: 3, toolName: "bash", text: "some output" },
		]);
		expect(plan.index).toBe(3);
		expect(plan.originalChars).toBe(11);
		expect(plan.stubText).toContain("bash");
		expect(plan.stubText).toContain("11");
		expect(plan.stubText).toContain(plan.digest);
	});

	it("gives identical text the same digest, so a repeated result demotes to the same stub", () => {
		const [a, b] = planDemotions([
			{ index: 0, toolName: "bash", text: "same" },
			{ index: 5, toolName: "bash", text: "same" },
		]);
		expect(a.digest).toBe(b.digest);
	});

	it("gives different text different digests even when their length matches", () => {
		const [a, b] = planDemotions([
			{ index: 0, toolName: "bash", text: "aaaa" },
			{ index: 1, toolName: "bash", text: "bbbb" },
		]);
		expect(a.digest).not.toBe(b.digest);
	});

	it("keeps the caller's index untouched, so a plan can be applied back by position", () => {
		const plans = planDemotions([
			{ index: 7, toolName: "bash", text: "x" },
			{ index: 2, toolName: "bash", text: "y" },
		]);
		expect(plans.map((p) => p.index)).toEqual([7, 2]);
	});
});
