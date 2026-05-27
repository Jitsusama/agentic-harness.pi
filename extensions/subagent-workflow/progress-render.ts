/**
 * Production progress reporter for the fleet.
 *
 * Maintains an in-memory snapshot of every subagent's
 * state and pushes it into pi's status line and a focused
 * prompt-area panel on each lifecycle event.
 *
 * - The status line shows a one-glance summary
 *   (`✓2/3 pending=1`) so the user always knows whether
 *   anyone is still working.
 * - The focused panel replaces the prompt editor while
 *   the tool runs, lists each subagent and lets the user
 *   cancel the selected subagent or the whole fleet
 *   without queuing another prompt behind the active
 *   tool.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import {
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import {
	type PipelineStage,
	renderPipelineProgressLines,
	type StageState,
} from "../../lib/ui/pipeline-progress.js";
import type {
	FleetProgress,
	FleetProgressEntry,
	FleetProgressState,
} from "./progress.js";

const STATUS_KEY = "subagent-workflow:fleet";

/** Controls that let the live progress panel interrupt subagents. */
export interface FleetProgressControls {
	cancelSubagent(subagentId: string): string;
	cancelAll(): string;
}

/**
 * Build a context-bound progress reporter for the fleet.
 * Returns the observer the orchestrator will notify.
 */
export function createFleetProgressReporter(
	ctx: ExtensionContext,
	controls?: FleetProgressControls,
): FleetProgress {
	let entries: FleetProgressEntry[] = [];
	let panel: FleetProgressPanel | null = null;
	let previousEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let terminalInputUnsubscribe: (() => void) | undefined;
	let editorInstalled = false;

	const render = (): void => {
		ctx.ui.setStatus(STATUS_KEY, renderStatusLine(entries, ctx.ui.theme));
		panel?.setEntries(entries);
	};

	const showPanel = (): void => {
		if (!ctx.hasUI || editorInstalled) return;
		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui) => {
			const component = new FleetProgressPanel(
				tui,
				ctx.ui.theme,
				entries,
				controls,
			);
			panel = component;
			return component;
		});
		terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) return undefined;
			controls?.cancelAll();
			return { consume: true };
		});
		editorInstalled = true;
	};

	const clear = (): void => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = undefined;
		if (editorInstalled) ctx.ui.setEditorComponent(previousEditor);
		editorInstalled = false;
		previousEditor = undefined;
		panel = null;
	};

	const updateEntry = (
		subagentId: string,
		patch: Partial<FleetProgressEntry>,
	): void => {
		entries = entries.map((entry) =>
			entry.spec.id === subagentId ? { ...entry, ...patch } : entry,
		);
	};

	return {
		start(initial) {
			entries = initial.map((entry) => ({ ...entry }));
			showPanel();
			render();
		},
		subagentStarted(subagentId) {
			updateEntry(subagentId, { state: "running", activity: "" });
			render();
		},
		subagentActivity(subagentId, activity) {
			updateEntry(subagentId, { activity });
			render();
		},
		subagentCompleted(subagentId, output) {
			updateEntry(subagentId, {
				state: "complete",
				warnings: output.warnings,
				activity: "",
				...(output.usage ? { usage: output.usage } : {}),
			});
			render();
		},
		subagentCancelled(subagentId) {
			updateEntry(subagentId, {
				state: "cancelled",
				activity: "",
				error: "cancelled by user",
			});
			render();
		},
		subagentFailed(subagentId, error) {
			updateEntry(subagentId, { state: "failed", error, activity: "" });
			render();
		},
		finish() {
			clear();
		},
	};
}

/**
 * Render the fleet progress widget lines (vertical
 * stage list). Exported so tests can assert structure
 * without poking into the UI.
 */
export function renderFleetWidgetLines(
	entries: readonly FleetProgressEntry[],
	theme: Theme,
): string[] {
	if (entries.length === 0) return [];
	const stages: PipelineStage[] = entries.map((entry) => ({
		label: entry.spec.id,
		state: stageStateFrom(entry.state),
		subtext: widgetSubtext(entry),
	}));
	const lines = renderPipelineProgressLines(stages, theme, { vertical: true });
	for (const entry of entries) {
		if (entry.state === "failed" && entry.error.length > 0) {
			lines.push(theme.fg("error", `  ✕ ${entry.spec.id}: ${entry.error}`));
		}
	}
	return lines;
}

/** Render the fleet status line summary. Exported for tests. */
export function renderFleetStatus(
	entries: readonly FleetProgressEntry[],
	theme: Theme,
	label = "fleet",
): string {
	const counts = countStates(entries);
	const total = entries.length;
	if (total === 0) return "";
	const summary = `${counts.complete}/${total} done`;
	const detail: string[] = [];
	if (counts.running > 0) detail.push(`running=${counts.running}`);
	if (counts.pending > 0) detail.push(`pending=${counts.pending}`);
	if (counts.cancelled > 0) detail.push(`cancelled=${counts.cancelled}`);
	if (counts.failed > 0) {
		detail.push(theme.fg("error", `failed=${counts.failed}`));
	}
	const tail = detail.length > 0 ? ` ${detail.join(" ")}` : "";
	return `${theme.fg("accent", label)} ${summary}${tail}`;
}

function renderStatusLine(
	entries: readonly FleetProgressEntry[],
	theme: Theme,
): string {
	return renderFleetStatus(entries, theme);
}

function widgetSubtext(entry: FleetProgressEntry): string | undefined {
	if (entry.state === "complete") {
		if (entry.usage) {
			return `${entry.usage.tokens.total.toLocaleString()} tokens`;
		}
		return "done";
	}
	if (entry.state === "running") {
		return entry.activity.length > 0 ? `last: ${entry.activity}` : "in flight";
	}
	if (entry.state === "pending") return "queued";
	if (entry.state === "cancelled") return "cancelled by user";
	return undefined;
}

function stageStateFrom(state: FleetProgressState): StageState {
	switch (state) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "complete":
			return "complete";
		case "cancelled":
			return "skipped";
		case "failed":
			return "failed";
	}
}

function countStates(
	entries: readonly FleetProgressEntry[],
): Record<FleetProgressState, number> {
	const counts: Record<FleetProgressState, number> = {
		pending: 0,
		running: 0,
		complete: 0,
		cancelled: 0,
		failed: 0,
	};
	for (const entry of entries) {
		counts[entry.state] += 1;
	}
	return counts;
}

/** Focused progress panel that can cancel active subagent subprocesses. */
export class FleetProgressPanel {
	borderColor?: (str: string) => string;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	private entries: FleetProgressEntry[];
	private selectedIndex = 0;
	private notice = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		entries: readonly FleetProgressEntry[],
		private readonly controls: FleetProgressControls | undefined,
		private readonly title = "Subagent Fleet",
	) {
		this.entries = entries.map((entry) => ({ ...entry }));
	}

	setEntries(entries: readonly FleetProgressEntry[]): void {
		this.entries = entries.map((entry) => ({ ...entry }));
		this.selectedIndex = clampSelection(
			this.selectedIndex,
			this.entries.length,
		);
		this.notice = "";
		this.tui.requestRender();
	}

	getText(): string {
		return "";
	}

	setText(_text: string): void {}

	addToHistory(_text: string): void {}

	insertTextAtCursor(_text: string): void {}

	getExpandedText(): string {
		return "";
	}

	setAutocompleteProvider(_provider: AutocompleteProvider): void {}

	setPaddingX(_padding: number): void {}

	setAutocompleteMaxVisible(_maxVisible: number): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = moveSelection(
				this.selectedIndex,
				this.entries.length,
				-1,
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = moveSelection(
				this.selectedIndex,
				this.entries.length,
				1,
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.notice = this.controls?.cancelAll() ?? "Cancellation unavailable.";
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			this.cancelSelected();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const add = (line: string) => lines.push(truncateToWidth(line, width));
		add(this.theme.fg("accent", "─".repeat(width)));
		add(` ${this.theme.fg("accent", this.theme.bold(this.title))}`);
		add(
			` ${this.theme.fg(
				"dim",
				"↑/↓ select · r cancel selected subagent · Esc cancel fleet",
			)}`,
		);
		if (this.notice) add(` ${this.theme.fg("warning", this.notice)}`);
		add("");
		if (this.entries.length === 0) {
			add(` ${this.theme.fg("dim", "No subagents in this fleet.")}`);
			add(this.theme.fg("accent", "─".repeat(width)));
			return lines;
		}
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (!entry) continue;
			add(this.renderEntry(entry, i === this.selectedIndex));
		}
		add(this.theme.fg("accent", "─".repeat(width)));
		return lines;
	}

	invalidate(): void {}

	private cancelSelected(): void {
		const entry = this.entries[this.selectedIndex];
		if (!entry) {
			this.notice = "No subagent selected.";
			return;
		}
		if (entry.state !== "running" && entry.state !== "pending") {
			this.notice = `${entry.spec.id} is already ${entry.state}.`;
			return;
		}
		this.notice =
			this.controls?.cancelSubagent(entry.spec.id) ??
			"Cancellation unavailable.";
	}

	private renderEntry(entry: FleetProgressEntry, selected: boolean): string {
		const cursor = selected ? "▸" : " ";
		const status = entryStatus(entry, this.theme);
		const activity = widgetSubtext(entry);
		const model = entry.spec.model ? ` · ${entry.spec.model}` : "";
		const suffix = activity ? ` · ${activity}` : "";
		const line = `${cursor} ${status} ${entry.spec.id}${model}${suffix}`;
		return selected ? this.theme.fg("accent", line) : line;
	}
}

function entryStatus(entry: FleetProgressEntry, theme: Theme): string {
	switch (entry.state) {
		case "pending":
			return theme.fg("muted", "◇ pending");
		case "running":
			return theme.fg("accent", "◈ running");
		case "complete":
			return theme.fg("success", "✓ complete");
		case "cancelled":
			return theme.fg("dim", "· cancelled");
		case "failed":
			return theme.fg("error", "✕ failed");
	}
}

function moveSelection(current: number, count: number, delta: number): number {
	if (count === 0) return 0;
	return (current + delta + count) % count;
}

function clampSelection(index: number, count: number): number {
	if (count === 0) return 0;
	return Math.min(index, count - 1);
}
