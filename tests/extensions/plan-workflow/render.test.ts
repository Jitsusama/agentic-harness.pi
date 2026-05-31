import { describe, expect, it } from "vitest";
import {
	renderStatus,
	renderWidget,
} from "../../../extensions/plan-workflow/render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

describe("renderStatus", () => {
	it("shows nothing at idle", () => {
		expect(renderStatus("idle", fakeTheme())).toBeUndefined();
	});

	it("shows a constant Plan label beside a stage glyph", () => {
		const think = renderStatus("think", fakeTheme());
		const build = renderStatus("build", fakeTheme());
		expect(think).toContain("Plan");
		expect(build).toContain("Plan");
		expect(think).not.toContain("think");
		expect(think).not.toBe(build); // the glyph carries the stage
	});
});

describe("renderWidget", () => {
	it("shows the stage, the progress and the title", () => {
		const [line] = renderWidget(
			{ stage: "build", title: "Workflow Redesign", done: 2, total: 5 },
			fakeTheme(),
			80,
		);
		expect(line).toContain("build");
		expect(line).toContain("2/5");
		expect(line).toContain("Workflow Redesign");
	});

	it("drops the progress when there are no checkboxes and tolerates no title", () => {
		const [line] = renderWidget(
			{ stage: "think", title: null, done: 0, total: 0 },
			fakeTheme(),
			80,
		);
		expect(line).toContain("think");
		expect(line).not.toContain("undefined");
		expect(line).not.toMatch(/\d+\/\d+/); // no progress fraction
	});

	it("truncates a long title to the available width", () => {
		const long = "x".repeat(200);
		const [line] = renderWidget(
			{ stage: "plan", title: long, done: 0, total: 3 },
			fakeTheme(),
			24,
		);
		expect(line).not.toContain(long);
	});
});
