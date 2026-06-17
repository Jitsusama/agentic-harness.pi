import { describe, expect, it } from "vitest";
import type {
	CouncilProgressEntry,
	CouncilProgressState,
} from "../../../extensions/pr-workflow/council-progress.js";
import {
	CouncilProgressPanel,
	createCouncilProgressReporter,
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

function plainTheme() {
	return {
		fg: (_colour: string, text: string) => text,
		bold: (text: string) => text,
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

	it("clears cancellation notices on the next progress update", () => {
		const { tui } = fakeTui();
		const panel = new CouncilProgressPanel(
			tui as never,
			fakeTheme(),
			[entry("fast", "running")],
			{
				cancelReviewer(id) {
					return `cancelled ${id}`;
				},
				cancelAll() {
					return "cancelled all";
				},
			},
		);

		panel.handleInput("r");
		expect(panel.render(80).join("\n")).toContain("cancelled fast");

		panel.setEntries([entry("fast", "cancelled")]);

		expect(panel.render(80).join("\n")).not.toContain("cancelled fast");
		expect(panel.render(80).join("\n")).toContain("cancelled by user");
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

	it("renders as a prompt-area panel with full-width borders", () => {
		const { tui } = fakeTui();
		const panel = new CouncilProgressPanel(
			tui as never,
			plainTheme() as never,
			[entry("fast", "running")],
			undefined,
		);

		const lines = panel.render(40);

		expect(lines[0]).toContain("─".repeat(40));
		expect(lines.at(-1)).toContain("─".repeat(40));
		expect(lines.join("\n")).toContain("PR Review Progress");
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

describe("createCouncilProgressReporter", () => {
	it("uses display labels for non-council progress actions", () => {
		const statuses: Array<string | undefined> = [];
		const ctx = {
			hasUI: false,
			ui: {
				theme: fakeTheme(),
				setStatus(_key: string, value: string | undefined) {
					statuses.push(value);
				},
				getEditorComponent: () => undefined,
				setEditorComponent() {},
			},
		};
		const reporter = createCouncilProgressReporter(ctx as never, undefined, {
			statusLabel: "judge",
		});

		reporter.start([entry("judge", "pending")]);

		expect(statuses[0]).toContain("judge");
		expect(statuses[0]).not.toContain("council");
	});

	it("replaces the prompt editor while progress is active and restores it on finish", () => {
		const previous = () => ({ render: () => [], invalidate() {} }) as never;
		const installed: unknown[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				theme: fakeTheme(),
				setStatus() {},
				onTerminalInput: () => () => {},
				getEditorComponent: () => previous,
				setEditorComponent(factory: unknown) {
					installed.push(factory);
				},
			},
		};
		const reporter = createCouncilProgressReporter(ctx as never, {
			cancelReviewer: () => "cancelled one",
			cancelAll: () => "cancelled all",
		});

		reporter.start([entry("fast", "pending")]);
		reporter.finish();

		expect(installed[0]).toEqual(expect.any(Function));
		expect(installed[1]).toBe(previous);
	});

	it("restores the editor on Escape even when no run is active to cancel", () => {
		// Escape must close the panel and return the
		// keyboard, not merely request cancellation. This is
		// the wedge regression: the registry was empty so
		// cancelAll found nothing, and the panel never
		// closed. Closing must not depend on cancellation.
		type TerminalHandler = (data: string) => { consume?: boolean } | undefined;
		const previous = () => ({ render: () => [], invalidate() {} }) as never;
		const installed: unknown[] = [];
		let escapeHandler: TerminalHandler | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				theme: fakeTheme(),
				setStatus() {},
				onTerminalInput(handler: TerminalHandler) {
					escapeHandler = handler;
					return () => {};
				},
				getEditorComponent: () => previous,
				setEditorComponent(factory: unknown) {
					installed.push(factory);
				},
			},
		};
		const reporter = createCouncilProgressReporter(ctx as never, {
			cancelReviewer: () => "cancelled one",
			// Simulates an empty registry: nothing to cancel.
			cancelAll: () => "No active reviewer subprocesses to cancel.",
		});

		reporter.start([entry("fast", "running")]);
		escapeHandler?.("\x1b");

		// The panel factory installed on start is replaced by
		// the previous editor: the keyboard is back.
		expect(installed.at(-1)).toBe(previous);
	});

	it("registers an escape-key terminal fallback for cancelling the run", () => {
		type TerminalHandler = (data: string) => { consume?: boolean } | undefined;
		const terminalHandlers: TerminalHandler[] = [];
		let unsubscribed = false;
		let cancelAllCalls = 0;
		const ctx = {
			hasUI: true,
			ui: {
				theme: fakeTheme(),
				setStatus() {},
				onTerminalInput(handler: TerminalHandler) {
					terminalHandlers.push(handler);
					return () => {
						unsubscribed = true;
					};
				},
				getEditorComponent: () => undefined,
				setEditorComponent() {},
			},
		};
		const reporter = createCouncilProgressReporter(ctx as never, {
			cancelReviewer: () => "cancelled one",
			cancelAll: () => {
				cancelAllCalls++;
				return "cancelled all";
			},
		});

		reporter.start([entry("fast", "running")]);

		expect(terminalHandlers).toHaveLength(1);
		const handleInput = terminalHandlers[0];
		expect(handleInput("x")?.consume).toBeUndefined();
		expect(handleInput("\x1b")?.consume).toBe(true);
		expect(cancelAllCalls).toBe(1);

		reporter.finish();

		expect(unsubscribed).toBe(true);
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
