import { describe, expect, it } from "vitest";
import { glyph, visualState } from "../../../extensions/tdd-workflow/glyphs.js";
import type { LoopState } from "../../../extensions/tdd-workflow/machine.js";

function loop(overrides: Partial<LoopState> = {}): LoopState {
	return {
		phase: "plan",
		redVerified: false,
		behaviour: null,
		loop: 1,
		engaged: true,
		...overrides,
	};
}

describe("visualState", () => {
	it("reads the plain phases straight through", () => {
		expect(visualState(loop({ phase: "idle" }))).toBe("idle");
		expect(visualState(loop({ phase: "plan" }))).toBe("plan");
		expect(visualState(loop({ phase: "write" }))).toBe("write");
		expect(visualState(loop({ phase: "green" }))).toBe("green");
		expect(visualState(loop({ phase: "refactor" }))).toBe("refactor");
	});

	it("splits red by whether the failure was a verified assertion", () => {
		expect(visualState(loop({ phase: "red", redVerified: false }))).toBe(
			"red-unverified",
		);
		expect(visualState(loop({ phase: "red", redVerified: true }))).toBe(
			"red-verified",
		);
	});
});

describe("glyph", () => {
	it("fills the circle as the test materializes, then transforms", () => {
		expect(glyph("idle")).toEqual({ char: "\u25cc", token: "dim" });
		expect(glyph("plan")).toEqual({ char: "\u25cb", token: "warning" });
		expect(glyph("write")).toEqual({ char: "\u25d0", token: "warning" });
		expect(glyph("red-unverified")).toEqual({ char: "\u25d0", token: "error" });
		expect(glyph("red-verified")).toEqual({ char: "\u25cf", token: "error" });
		expect(glyph("green")).toEqual({ char: "\u2713", token: "success" });
		expect(glyph("refactor")).toEqual({ char: "\u25c6", token: "accent" });
	});
});
