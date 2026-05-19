import { describe, expect, it } from "vitest";
import {
	NARRATION_GLYPH,
	renderNarrationLine,
} from "../../../lib/ui/narration.js";
import { fakeTheme } from "./fake-theme.js";

describe("NARRATION_GLYPH", () => {
	it("is the ※ reference mark, exported as the canonical narration glyph", () => {
		// External code (status fragments, log writers) keys off
		// this exact glyph. Pinning the value catches accidental
		// drift.
		expect(NARRATION_GLYPH).toBe("※");
	});
});

describe("renderNarrationLine", () => {
	const theme = fakeTheme();

	it("renders glyph, prefix, body with the documented spacing", () => {
		// Format is `※ prefix: body` with the glyph dimmed,
		// the prefix coloured by level, and the body dimmed.
		// Three space-separated tokens.
		const line = renderNarrationLine("nvim", "opened state.ts", theme);
		expect(line).toBe(
			"<dim>※</dim> <muted>nvim:</muted> <dim>opened state.ts</dim>",
		);
	});

	it("uses warning accent on the prefix at warn level", () => {
		const line = renderNarrationLine("pr-workflow", "council partial", theme, {
			level: "warn",
		});
		expect(line).toBe(
			"<dim>※</dim> <warning>pr-workflow:</warning> <dim>council partial</dim>",
		);
	});

	it("uses error accent on the prefix at error level", () => {
		const line = renderNarrationLine("nvim", "detached unexpectedly", theme, {
			level: "error",
		});
		expect(line).toBe(
			"<dim>※</dim> <error>nvim:</error> <dim>detached unexpectedly</dim>",
		);
	});

	it("keeps the body dimmed regardless of level", () => {
		// Only the prefix shifts colour with level; the body
		// stays dim so the line as a whole reads as ambient.
		const warn = renderNarrationLine("p", "b", theme, { level: "warn" });
		const error = renderNarrationLine("p", "b", theme, { level: "error" });
		expect(warn).toContain("<dim>b</dim>");
		expect(error).toContain("<dim>b</dim>");
	});

	it("suppresses the leading glyph when noGlyph is true", () => {
		const line = renderNarrationLine("nvim", "ok", theme, { noGlyph: true });
		expect(line).toBe("<muted>nvim:</muted> <dim>ok</dim>");
		expect(line).not.toContain("※");
	});
});
