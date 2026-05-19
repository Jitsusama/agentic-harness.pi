import { describe, expect, it } from "vitest";
import {
	type PipelineStage,
	renderPipelineProgress,
	renderPipelineProgressLines,
} from "../../../lib/ui/pipeline-progress.js";
import { fakeTheme } from "./fake-theme.js";

function stages(...defs: PipelineStage[]): PipelineStage[] {
	return defs;
}

describe("renderPipelineProgress", () => {
	const theme = fakeTheme();

	it("renders each stage state with its documented glyph and colour", () => {
		// One stage per state, horizontal mode, default
		// connector. Stage glyph and label colour both come
		// from the state. Running additionally bolds the
		// label.
		const out = renderPipelineProgress(
			stages(
				{ label: "pending", state: "pending" },
				{ label: "running", state: "running" },
				{ label: "complete", state: "complete" },
				{ label: "skipped", state: "skipped" },
				{ label: "failed", state: "failed" },
			),
			theme,
		);
		expect(out).toBe(
			[
				"<muted>◇</muted> <muted>pending</muted>",
				"<accent>◈</accent> <accent><b>running</b></accent>",
				"<success>✓</success> <success>complete</success>",
				"<dim>·</dim> <dim>skipped</dim>",
				"<error>✕</error> <error>failed</error>",
			].join(" <dim>─▸</dim> "),
		);
	});

	it("returns a string with stages joined by the default connector when horizontal", () => {
		const out = renderPipelineProgress(
			stages(
				{ label: "a", state: "complete" },
				{ label: "b", state: "running" },
			),
			theme,
		);
		expect(typeof out).toBe("string");
		expect(out).toContain(" <dim>─▸</dim> ");
	});

	it("returns one string per stage when vertical is true", () => {
		const out = renderPipelineProgress(
			stages(
				{ label: "a", state: "complete" },
				{ label: "b", state: "running" },
				{ label: "c", state: "pending" },
			),
			theme,
			{ vertical: true },
		);
		expect(Array.isArray(out)).toBe(true);
		expect(out).toHaveLength(3);
	});

	it("appends subtext in parentheses, dimmed, when present", () => {
		const out = renderPipelineProgress(
			stages({ label: "fanout", state: "running", subtext: "3/5" }),
			theme,
		);
		expect(out).toBe(
			"<accent>◈</accent> <accent><b>fanout</b></accent> <dim>(3/5)</dim>",
		);
	});

	it("omits subtext when showSubtext is false", () => {
		const out = renderPipelineProgress(
			stages({ label: "fanout", state: "running", subtext: "3/5" }),
			theme,
			{ showSubtext: false },
		);
		expect(out).not.toContain("(3/5)");
	});

	it("uses the override connector between stages", () => {
		const out = renderPipelineProgress(
			stages(
				{ label: "a", state: "complete" },
				{ label: "b", state: "running" },
			),
			theme,
			{ connector: "→" },
		);
		expect(out).toContain(" <dim>→</dim> ");
		expect(out).not.toContain("─▸");
	});

	it("renders an empty connector-less string when given no stages", () => {
		expect(renderPipelineProgress([], theme)).toBe("");
	});
});

describe("renderPipelineProgressLines", () => {
	const theme = fakeTheme();

	it("returns string[] in horizontal mode by wrapping the single line", () => {
		const lines = renderPipelineProgressLines(
			stages(
				{ label: "a", state: "complete" },
				{ label: "b", state: "running" },
			),
			theme,
		);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("<dim>─▸</dim>");
	});

	it("returns the per-stage lines verbatim in vertical mode", () => {
		const lines = renderPipelineProgressLines(
			stages(
				{ label: "a", state: "complete" },
				{ label: "b", state: "pending" },
			),
			theme,
			{ vertical: true },
		);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("<success>✓</success> <success>a</success>");
		expect(lines[1]).toBe("<muted>◇</muted> <muted>b</muted>");
	});
});
