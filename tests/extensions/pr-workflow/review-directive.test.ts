import { describe, expect, it } from "vitest";
import { reviewValidationDirective } from "../../../extensions/pr-workflow/review-directive.js";

// After the judge or stack review consolidates findings,
// the tool output must lead the main agent into a
// validation pass rather than handing over a decide-ready
// list. The findings are unvalidated candidates from
// reviewer subagents that can be confidently wrong, so the
// directive names the four steps the agent runs before
// presenting anything.

describe("reviewValidationDirective", () => {
	const directive = reviewValidationDirective();

	it("frames the findings as unvalidated candidates", () => {
		expect(directive.toLowerCase()).toContain("unvalidated");
	});

	it("names all four validation steps", () => {
		const text = directive.toLowerCase();
		expect(text).toContain("source");
		expect(text).toContain("duplicate");
		expect(text).toContain("root cause");
		expect(text).toMatch(/author|direction/);
	});

	it("uses no emdash or curly punctuation", () => {
		expect(directive).not.toMatch(/[\u2014\u2018\u2019\u201c\u201d\u2026]/);
	});
});
