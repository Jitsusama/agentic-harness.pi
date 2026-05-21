/**
 * Production progress reporter for the council.
 *
 * Maintains an in-memory snapshot of every reviewer's
 * state and pushes it into pi's status line and a focused
 * prompt-area panel on each lifecycle event.
 *
 * - The status line shows a one-glance summary
 *   (`✓2/3 pending=1`) so the user always knows
 *   whether anyone is still working.
 * - The focused panel replaces the prompt editor while
 *   the tool runs, lists each reviewer and lets the user
 *   cancel the selected reviewer or the whole run without
 *   queuing another prompt behind the active tool.
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
	CouncilProgress,
	CouncilProgressEntry,
	CouncilProgressState,
} from "./council-progress.js";

const STATUS_KEY = "pr-workflow:council";

/** Controls that let the live progress panel interrupt reviewers. */
export interface CouncilProgressControls {
	cancelReviewer(reviewerId: string): string;
	cancelAll(): string;
}

/**
 * Build a context-bound progress reporter for the
 * council. Returns the observer the orchestrator will
 * notify.
 */
export interface CouncilProgressDisplayOptions {
	readonly statusLabel?: string;
	readonly title?: string;
}

export function createCouncilProgressReporter(
	ctx: ExtensionContext,
	controls?: CouncilProgressControls,
	display: CouncilProgressDisplayOptions = {},
): CouncilProgress {
	let entries: CouncilProgressEntry[] = [];
	let panel: CouncilProgressPanel | null = null;
	let previousEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let editorInstalled = false;

	const render = (): void => {
		const theme = ctx.ui.theme;
		ctx.ui.setStatus(
			STATUS_KEY,
			renderStatusLine(entries, theme, display.statusLabel ?? "council"),
		);
		panel?.setEntries(entries);
	};

	const showPanel = (): void => {
		if (!ctx.hasUI || editorInstalled) return;
		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui) => {
			const component = new CouncilProgressPanel(
				tui,
				ctx.ui.theme,
				entries,
				controls,
				display.title,
			);
			panel = component;
			return component;
		});
		editorInstalled = true;
	};

	const clear = (): void => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (editorInstalled) ctx.ui.setEditorComponent(previousEditor);
		editorInstalled = false;
		previousEditor = undefined;
		panel = null;
	};

	const updateEntry = (
		reviewerId: string,
		patch: Partial<CouncilProgressEntry>,
	): void => {
		entries = entries.map((entry) =>
			entry.reviewer.id === reviewerId ? { ...entry, ...patch } : entry,
		);
	};

	return {
		start(initial) {
			entries = initial.map((entry) => ({ ...entry }));
			showPanel();
			render();
		},
		reviewerStarted(reviewerId) {
			updateEntry(reviewerId, { state: "running", activity: "" });
			render();
		},
		reviewerActivity(reviewerId, activity) {
			updateEntry(reviewerId, { activity });
			render();
		},
		reviewerCompleted(reviewerId, output) {
			updateEntry(reviewerId, {
				state: "complete",
				findingCount: output.findings?.length ?? 0,
				completedLabel: output.completedLabel,
				warnings: output.warnings,
				activity: "",
			});
			render();
		},
		reviewerCancelled(reviewerId) {
			updateEntry(reviewerId, {
				state: "cancelled",
				activity: "",
				error: "cancelled by user",
			});
			render();
		},
		reviewerFailed(reviewerId, error) {
			updateEntry(reviewerId, { state: "failed", error, activity: "" });
			render();
		},
		finish() {
			// Hold the final snapshot for a tick so the user
			// sees the last update, then clear. The status
			// line clears immediately; the widget would
			// otherwise stick around forever.
			clear();
		},
	};
}

/**
 * Render the council progress as horizontal pipeline
 * stages. Exported so tests can assert structure
 * without poking into the UI.
 */
export function renderCouncilStatus(
	entries: readonly CouncilProgressEntry[],
	theme: Theme,
	label = "council",
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
	entries: readonly CouncilProgressEntry[],
	theme: Theme,
	label: string,
): string {
	return renderCouncilStatus(entries, theme, label);
}

/** Render the council progress widget lines. */
export function renderCouncilWidgetLines(
	entries: readonly CouncilProgressEntry[],
	theme: Theme,
): string[] {
	if (entries.length === 0) return [];
	const stages: PipelineStage[] = entries.map((entry) => ({
		label: entry.reviewer.id,
		state: stageStateFrom(entry.state),
		subtext: widgetSubtext(entry),
	}));
	const lines = renderPipelineProgressLines(stages, theme, { vertical: true });
	for (const entry of entries) {
		if (entry.state === "failed" && entry.error.length > 0) {
			lines.push(theme.fg("error", `  ✕ ${entry.reviewer.id}: ${entry.error}`));
		}
	}
	return lines;
}

function widgetSubtext(entry: CouncilProgressEntry): string | undefined {
	if (entry.state === "complete") {
		if (entry.completedLabel) return entry.completedLabel;
		const noun = entry.findingCount === 1 ? "finding" : "findings";
		return `${entry.findingCount} ${noun}`;
	}
	if (entry.state === "running") {
		return entry.activity.length > 0 ? `last: ${entry.activity}` : "in flight";
	}
	if (entry.state === "pending") return "queued";
	if (entry.state === "cancelled") return "cancelled by user";
	return undefined;
}

function stageStateFrom(state: CouncilProgressState): StageState {
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
	entries: readonly CouncilProgressEntry[],
): Record<CouncilProgressState, number> {
	const counts: Record<CouncilProgressState, number> = {
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

/** Focused progress panel that can cancel active reviewer subprocesses. */
export class CouncilProgressPanel {
	borderColor?: (str: string) => string;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	private entries: CouncilProgressEntry[];
	private selectedIndex = 0;
	private notice = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		entries: readonly CouncilProgressEntry[],
		private readonly controls: CouncilProgressControls | undefined,
		private readonly title = "PR review progress",
	) {
		this.entries = entries.map((entry) => ({ ...entry }));
	}

	setEntries(entries: readonly CouncilProgressEntry[]): void {
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
				"↑/↓ select · r cancel selected reviewer · Esc cancel run",
			)}`,
		);
		if (this.notice) add(` ${this.theme.fg("warning", this.notice)}`);
		add("");
		if (this.entries.length === 0) {
			add(` ${this.theme.fg("dim", "No reviewers in this run.")}`);
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
			this.notice = "No reviewer selected.";
			return;
		}
		if (entry.state !== "running" && entry.state !== "pending") {
			this.notice = `${entry.reviewer.id} is already ${entry.state}.`;
			return;
		}
		this.notice =
			this.controls?.cancelReviewer(entry.reviewer.id) ??
			"Cancellation unavailable.";
	}

	private renderEntry(entry: CouncilProgressEntry, selected: boolean): string {
		const cursor = selected ? "▸" : " ";
		const status = entryStatus(entry, this.theme);
		const activity = widgetSubtext(entry);
		const model = entry.reviewer.model ? ` · ${entry.reviewer.model}` : "";
		const suffix = activity ? ` · ${activity}` : "";
		const line = `${cursor} ${status} ${entry.reviewer.id}${model}${suffix}`;
		return selected ? this.theme.fg("accent", line) : line;
	}
}

function entryStatus(entry: CouncilProgressEntry, theme: Theme): string {
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
