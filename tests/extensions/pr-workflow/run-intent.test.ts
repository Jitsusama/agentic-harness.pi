import { describe, expect, it } from "vitest";
import { composeRunAddendum } from "../../../extensions/pr-workflow/run-intent.js";

describe("composeRunAddendum", () => {
	it("returns undefined when neither source is present", () => {
		expect(composeRunAddendum(undefined, undefined)).toBeUndefined();
		expect(composeRunAddendum("", "  ")).toBeUndefined();
	});

	it("returns the provider context alone when there is no intent", () => {
		expect(composeRunAddendum("Provider context.", undefined)).toBe(
			"Provider context.",
		);
	});

	it("returns the intent under a heading when there is no provider context", () => {
		const out = composeRunAddendum(undefined, "Focus on the auth changes.");
		expect(out).toContain("Focus on the auth changes.");
		expect(out).toMatch(/## This run/);
	});

	it("joins provider context and intent when both are present", () => {
		const out = composeRunAddendum("Provider context.", "Be stricter.");
		expect(out).toContain("Provider context.");
		expect(out).toContain("Be stricter.");
		// Provider context first, then the run intent.
		expect(out?.indexOf("Provider context.")).toBeLessThan(
			out?.indexOf("Be stricter.") ?? -1,
		);
	});

	it("trims surrounding whitespace on both sources", () => {
		expect(composeRunAddendum("  ctx  ", undefined)).toBe("ctx");
		expect(composeRunAddendum(undefined, "  do this  ")).toContain("do this");
	});
});
