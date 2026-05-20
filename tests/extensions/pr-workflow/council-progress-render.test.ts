import { describe, expect, it } from "vitest";
import type {
	CouncilProgressEntry,
	CouncilProgressState,
} from "../../../extensions/pr-workflow/council-progress.js";
import {
	renderCouncilStatus,
	renderCouncilWidgetLines,
} from "../../../extensions/pr-workflow/council-progress-render.js";
import { fakeTheme } from "../../lib/ui/fake-theme.js";

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
		expect(line).not.toContain("failed=");
	});

	it("returns empty for an empty entry list", () => {
		expect(renderCouncilStatus([], fakeTheme())).toBe("");
	});
});
