import { describe, expect, it } from "vitest";
import type {
	CouncilProgressEntry,
	CouncilProgressState,
} from "../../../extensions/pr-workflow/council-progress.js";
import {
	CouncilProgressPanel,
	renderCouncilStatus,
	renderCouncilWidgetLines,
} from "../../../extensions/pr-workflow/council-progress-render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

function fakeTui() {
	let renders = 0;
	return {
		tui: { requestRender: () => renders++ },
		renderCount: () => renders,
	};
}

function entry(
	id: string,
	state: CouncilProgressState,
	overrides: Partial<CouncilProgressEntry> = {},
): CouncilProgressEntry {
	return {
		reviewer: { id },
		state,
		findingCount: 0,
		warnings: [],
		error: "",
		activity: "",
		...overrides,
	};
}

describe("renderCouncilWidgetLines", () => {
	it("labels running activity as the last observed event", () => {
		const lines = renderCouncilWidgetLines(
			[entry("fast", "running", { activity: "reading main.go" })],
			fakeTheme(),
		);
		expect(lines.join("\n")).toContain("last: reading main.go");
	});

	it("shows tool-end waiting state instead of implying the tool still runs", () => {
		const lines = renderCouncilWidgetLines(
			[
				entry("skeptic", "running", {
					activity: "finished verifying output; waiting for model",
				}),
			],
			fakeTheme(),
		);
		expect(lines.join("\n")).toContain(
			"last: finished verifying output; waiting for model",
		);
	});
});

describe("CouncilProgressPanel", () => {
	it("cancels the selected reviewer without queueing a tool prompt", () => {
		const calls: string[] = [];
		const { tui } = fakeTui();
		const panel = new CouncilProgressPanel(
			tui as never,
			fakeTheme(),
			[entry("fast", "running"), entry("skeptic", "running")],
			{
				cancelReviewer(id) {
					calls.push(`one:${id}`);
					return `cancelled ${id}`;
				},
				cancelAll() {
					calls.push("all");
					return "cancelled all";
				},
			},
		);

		panel.handleInput("\x1b[B");
		panel.handleInput("r");

		expect(calls).toEqual(["one:skeptic"]);
		expect(panel.render(80).join("\n")).toContain("cancelled skeptic");
	});

	it("cancels the whole run on Escape", () => {
		const calls: string[] = [];
		const { tui } = fakeTui();
		const panel = new CouncilProgressPanel(
			tui as never,
			fakeTheme(),
			[entry("fast", "running")],
			{
				cancelReviewer(id) {
					calls.push(`one:${id}`);
					return `cancelled ${id}`;
				},
				cancelAll() {
					calls.push("all");
					return "cancelled all";
				},
			},
		);

		panel.handleInput("\x1b");

		expect(calls).toEqual(["all"]);
		expect(panel.render(80).join("\n")).toContain("cancelled all");
	});

	it("does not cancel a reviewer that already completed", () => {
		const calls: string[] = [];
		const { tui } = fakeTui();
		const panel = new CouncilProgressPanel(
			tui as never,
			fakeTheme(),
			[entry("fast", "complete")],
			{
				cancelReviewer(id) {
					calls.push(`one:${id}`);
					return `cancelled ${id}`;
				},
				cancelAll() {
					calls.push("all");
					return "cancelled all";
				},
			},
		);

		panel.handleInput("r");

		expect(calls).toEqual([]);
		expect(panel.render(80).join("\n")).toContain("already complete");
	});
});

describe("renderCouncilStatus", () => {
	it("counts complete and total reviewers in the summary", () => {
		const line = renderCouncilStatus(
			[entry("a", "complete"), entry("b", "running")],
			fakeTheme(),
		);
		expect(line).toContain("1/2 done");
	});

	it("surfaces a running detail when any reviewer is in flight", () => {
		const line = renderCouncilStatus(
			[entry("a", "running"), entry("b", "running")],
			fakeTheme(),
		);
		expect(line).toContain("running=2");
	});

	it("surfaces cancelled reviewers in the detail tail", () => {
		const line = renderCouncilStatus(
			[entry("a", "complete"), entry("b", "cancelled")],
			fakeTheme(),
		);
		expect(line).toContain("cancelled=1");
	});

	it("renders cancelled reviewers as cancelled by user", () => {
		const lines = renderCouncilWidgetLines(
			[entry("slow", "cancelled")],
			fakeTheme(),
		);
		expect(lines.join("\n")).toContain("cancelled by user");
	});

	it("surfaces a failed detail in the error colour", () => {
		const line = renderCouncilStatus(
			[entry("a", "complete"), entry("b", "failed", { error: "boom" })],
			fakeTheme(),
		);
		expect(line).toContain("failed=1");
	});

	it("omits detail tail when only counts that are zero exist", () => {
		const line = renderCouncilStatus(
			[entry("a", "complete"), entry("b", "complete")],
			fakeTheme(),
		);
		expect(line).toContain("2/2 done");
		expect(line).not.toContain("running=");
		expect(line).not.toContain("pending=");
		expect(line).not.toContain("cancelled=");
		expect(line).not.toContain("failed=");
	});

	it("returns empty for an empty entry list", () => {
		expect(renderCouncilStatus([], fakeTheme())).toBe("");
	});
});
