import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import type { PlanSummary } from "../../../extensions/plan-workflow/discovery.js";
import {
	formatPlanList,
	renderStatus,
	renderWidget,
} from "../../../extensions/plan-workflow/render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

/** Strip fakeTheme's <token> markers so width assertions see only glyph text. */
function plain(line: string): string {
	return line.replace(/<\/?[^>]+>/g, "");
}

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

	it("fills the circle monotonically across the active lifecycle", () => {
		expect(renderStatus("think", fakeTheme())).toContain("\u25cb"); // ○
		expect(renderStatus("plan", fakeTheme())).toContain("\u25d1"); // ◑
		expect(renderStatus("build", fakeTheme())).toContain("\u25d5"); // ◕
		expect(renderStatus("concluded", fakeTheme())).toContain("\u25cf"); // ●
		expect(renderStatus("retired", fakeTheme())).toContain("\u2298"); // ⊘
	});
});

describe("renderWidget", () => {
	it("shows the stage and the title beside a 1-based step position", () => {
		const [line] = renderWidget(
			{ stage: "build", title: "Workflow Redesign", done: 2, total: 5 },
			fakeTheme(),
			80,
		);
		expect(line).toContain("build");
		expect(line).toContain("3/5"); // done+1 of total: the step in progress
		expect(line).not.toContain("2/5");
		expect(line).toContain("Workflow Redesign");
	});

	it("shows total/total once every box is checked", () => {
		const [line] = renderWidget(
			{ stage: "build", title: "Done Plan", done: 5, total: 5 },
			fakeTheme(),
			80,
		);
		expect(line).toContain("5/5");
		expect(line).not.toContain("6/5");
	});

	it("fills the glyph by completion in quarter buckets", () => {
		const glyphOf = (done: number, total: number) =>
			plain(
				renderWidget(
					{ stage: "build", title: null, done, total },
					fakeTheme(),
					80,
				)[0],
			).charAt(0);
		expect(glyphOf(0, 8)).toBe("\u25cb"); // ○ empty
		expect(glyphOf(1, 8)).toBe("\u25d4"); // ◔ a quarter
		expect(glyphOf(3, 8)).toBe("\u25d1"); // ◑ half
		expect(glyphOf(6, 8)).toBe("\u25d5"); // ◕ three-quarter
		expect(glyphOf(8, 8)).toBe("\u25cf"); // ● full
	});

	it("shows an empty circle and no fraction when there are no checkboxes", () => {
		const [line] = renderWidget(
			{ stage: "think", title: null, done: 0, total: 0 },
			fakeTheme(),
			80,
		);
		expect(line).toContain("think");
		expect(line).toContain("\u25cb"); // ○ empty meter
		expect(line).not.toContain("undefined");
		expect(line).not.toMatch(/\d+\/\d+/); // no progress fraction
	});

	it("spaces the middot from the progress", () => {
		const [line] = renderWidget(
			{ stage: "build", title: null, done: 2, total: 5 },
			fakeTheme(),
			80,
		);
		expect(plain(line)).toContain("\u00b7 3/5");
		expect(plain(line)).not.toContain("\u00b73/5");
	});

	it("truncates a long title to the available width", () => {
		const long = "x".repeat(200);
		const [line] = renderWidget(
			{ stage: "plan", title: long, done: 0, total: 3 },
			fakeTheme(),
			60,
		);
		expect(line).not.toContain(long);
	});

	it("never emits a line wider than the available width", () => {
		const [line] = renderWidget(
			{ stage: "build", title: "z".repeat(200), done: 4, total: 11 },
			fakeTheme(),
			24,
		);
		expect(visibleWidth(plain(line))).toBeLessThanOrEqual(24);
	});
});
