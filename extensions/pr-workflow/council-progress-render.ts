/**
 * Production progress reporter for the council.
 *
 * Maintains an in-memory snapshot of every reviewer's
 * state and pushes it into pi's status line and widget
 * surfaces on each lifecycle event.
 *
 * - The status line shows a one-glance summary
 *   (`✓2/3 pending=1`) so the user always knows
 *   whether anyone is still working.
 * - The widget is a vertical list with one line per
 *   reviewer: glyph, id, state, finding count when
 *   known, first warning when failed.
 *
 * The reporter is registered with `ctx.ui.setStatus`
 * and `ctx.ui.setWidget`; both surface clear on
 * `finish()` so a fresh run starts from a clean slate.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
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
const WIDGET_KEY = "pr-workflow:council";

/**
 * Build a context-bound progress reporter for the
 * council. Returns the observer the orchestrator will
 * notify.
 */
export function createCouncilProgressReporter(
	ctx: ExtensionContext,
): CouncilProgress {
	let entries: CouncilProgressEntry[] = [];

	const render = (): void => {
		const theme = ctx.ui.theme;
		ctx.ui.setStatus(STATUS_KEY, renderStatusLine(entries, theme));
		ctx.ui.setWidget(WIDGET_KEY, (_tui, t) => ({
			render(_width: number): string[] {
				return renderWidgetLines(entries, t);
			},
			invalidate() {},
		}));
	};

	const clear = (): void => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
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
				findingCount: output.findings.length,
				warnings: output.warnings,
				activity: "",
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
): string {
	const counts = countStates(entries);
	const total = entries.length;
	if (total === 0) return "";
	const summary = `${counts.complete}/${total} done`;
	const detail: string[] = [];
	if (counts.running > 0) detail.push(`running=${counts.running}`);
	if (counts.pending > 0) detail.push(`pending=${counts.pending}`);
	if (counts.failed > 0) {
		detail.push(theme.fg("error", `failed=${counts.failed}`));
	}
	const tail = detail.length > 0 ? ` ${detail.join(" ")}` : "";
	return `${theme.fg("accent", "council")} ${summary}${tail}`;
}

function renderStatusLine(
	entries: readonly CouncilProgressEntry[],
	theme: Theme,
): string {
	return renderCouncilStatus(entries, theme);
}

function renderWidgetLines(
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
		const noun = entry.findingCount === 1 ? "finding" : "findings";
		return `${entry.findingCount} ${noun}`;
	}
	if (entry.state === "running") {
		return entry.activity.length > 0 ? entry.activity : "in flight";
	}
	if (entry.state === "pending") return "queued";
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
		failed: 0,
	};
	for (const entry of entries) {
		counts[entry.state] += 1;
	}
	return counts;
}
