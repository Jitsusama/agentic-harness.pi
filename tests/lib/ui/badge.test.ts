import { describe, expect, it } from "vitest";
import { renderBadge, renderBar } from "../../../lib/ui/badge.js";
import { fakeTheme } from "./fake-theme.js";

describe("renderBadge", () => {
	const theme = fakeTheme();

	it("renders a glyph for each kind in the kind's semantic colour", () => {
		expect(renderBadge("critical", theme)).toBe("<error>●</error>");
		expect(renderBadge("warning", theme)).toBe("<warning>●</warning>");
		expect(renderBadge("info", theme)).toBe("<accent>●</accent>");
		expect(renderBadge("ok", theme)).toBe("<success>●</success>");
		expect(renderBadge("muted", theme)).toBe("<dim>·</dim>");
		expect(renderBadge("running", theme)).toBe("<accent>◈</accent>");
		expect(renderBadge("pending", theme)).toBe("<muted>◇</muted>");
		expect(renderBadge("skipped", theme)).toBe("<dim>·</dim>");
		expect(renderBadge("rejected", theme)).toBe("<error>✕</error>");
	});

	it("appends a label separated by a space when given", () => {
		expect(renderBadge("ok", theme, { label: "5/7" })).toBe(
			"<success>● 5/7</success>",
		);
		expect(renderBadge("running", theme, { label: "R1" })).toBe(
			"<accent>◈ R1</accent>",
		);
	});

	it("uses the kind's colour for the whole composed token", () => {
		// The whole glyph+label string is wrapped in one colour
		// tag, not split into two. That's how it composes
		// inside a larger themed line.
		const out = renderBadge("critical", theme, { label: "block" });
		expect(out).toBe("<error>● block</error>");
	});

	it("overrides the default glyph when options.glyph is set", () => {
		expect(renderBadge("info", theme, { glyph: "★" })).toBe(
			"<accent>★</accent>",
		);
		expect(renderBadge("ok", theme, { glyph: "▣", label: "done" })).toBe(
			"<success>▣ done</success>",
		);
	});
});

describe("renderBar", () => {
	const theme = fakeTheme();

	it("renders filled and empty cells totalling the default width of 7", () => {
		// 6/7 → 6 filled, 1 empty; fraction text in dim.
		expect(renderBar(6, 7, theme)).toBe(
			"<success>▰▰▰▰▰▰</success><dim>▱</dim> <dim>6/7</dim>",
		);
	});

	it("honours an overridden width", () => {
		// 3/5 with width 5 → 3 filled, 2 empty.
		expect(renderBar(3, 5, theme, { width: 5 })).toBe(
			"<success>▰▰▰</success><dim>▱▱</dim> <dim>3/5</dim>",
		);
	});

	it("clamps a numerator above the denominator to a full bar", () => {
		expect(renderBar(99, 5, theme, { width: 5 })).toBe(
			"<success>▰▰▰▰▰</success><dim></dim> <dim>5/5</dim>",
		);
	});

	it("clamps a negative numerator to an empty bar", () => {
		expect(renderBar(-3, 5, theme, { width: 5 })).toBe(
			"<success></success><dim>▱▱▱▱▱</dim> <dim>0/5</dim>",
		);
	});

	it("renders an empty bar when the denominator is zero", () => {
		expect(renderBar(0, 0, theme, { width: 4 })).toBe(
			"<success></success><dim>▱▱▱▱</dim> <dim>0/0</dim>",
		);
	});

	it("hides the trailing fraction text when hideFraction is true", () => {
		expect(renderBar(3, 5, theme, { width: 5, hideFraction: true })).toBe(
			"<success>▰▰▰</success><dim>▱▱</dim>",
		);
	});

	it("themes filled cells with the colour override", () => {
		expect(renderBar(2, 4, theme, { width: 4, color: "warning" })).toBe(
			"<warning>▰▰</warning><dim>▱▱</dim> <dim>2/4</dim>",
		);
	});

	it("rounds the filled count to the nearest cell", () => {
		// 1/3 of 5 cells = 1.66 → rounds to 2 filled.
		expect(renderBar(1, 3, theme, { width: 5, hideFraction: true })).toBe(
			"<success>▰▰</success><dim>▱▱▱</dim>",
		);
	});
});
