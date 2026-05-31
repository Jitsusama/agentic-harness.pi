import { describe, expect, it } from "vitest";
import type { PlanSummary } from "../../../extensions/plan-workflow/discovery.js";
import {
	formatPlanList,
	renderStatus,
	renderWidget,
} from "../../../extensions/plan-workflow/render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

function row(over: Partial<PlanSummary>): PlanSummary {
	return {
		id: "PLAN-20260530-ksz",
		title: "Discover Plans",
		stage: "build",
		updated: "2026-05-30",
		done: 1,
		total: 3,
		fileName: "plan.md",
		...over,
	};
}

describe("formatPlanList", () => {
	it("renders one line per plan with id, stage, progress and title", () => {
		const out = formatPlanList([
			row({
				id: "PLAN-20260530-ksz",
				title: "Discover Plans",
				done: 1,
				total: 3,
			}),
			row({ id: "PLAN-20260501-abc", title: "Older Plan", done: 4, total: 4 }),
		]);
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("PLAN-20260530-ksz");
		expect(lines[0]).toContain("build");
		expect(lines[0]).toContain("1/3");
		expect(lines[0]).toContain("Discover Plans");
	});

	it("shows a dash for a plan with no checkboxes", () => {
		const out = formatPlanList([row({ done: 0, total: 0 })]);
		expect(out).not.toMatch(/\d+\/\d+/);
		expect(out).toContain("-");
	});

	it("marks a plan with no title as untitled", () => {
		const out = formatPlanList([row({ title: null })]);
		expect(out).toContain("untitled");
		expect(out).not.toContain("null");
	});
});

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
