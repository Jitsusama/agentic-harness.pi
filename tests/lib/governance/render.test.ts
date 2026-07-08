import { describe, expect, it } from "vitest";
import { renderRulesBlock } from "../../../lib/governance/render.js";
import type { GovernanceRule } from "../../../lib/governance/types.js";

function rule(text: string): GovernanceRule {
	return { id: "x", text, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("renderRulesBlock", () => {
	it("contributes nothing when there are no rules", () => {
		expect(renderRulesBlock([])).toBeUndefined();
	});

	it("renders each rule as a list item under a heading", () => {
		const block = renderRulesBlock([
			rule("keep breadth unless told to narrow"),
			rule("ground each recommendation in the workflow"),
		]);
		expect(block).toContain("## Learned Conventions");
		expect(block).toContain("- keep breadth unless told to narrow");
		expect(block).toContain("- ground each recommendation in the workflow");
	});
});
