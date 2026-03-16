/**
 * Live progress panel for context gathering.
 *
 * Shows a real-time view of parallel fetch tasks with status
 * glyphs. Each task updates independently as its promise
 * resolves, triggering re-renders.
 *
 * Glyphs: ◆ done, ◇ pending, ◈ in progress, ✕ failed.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { GLYPH } from "../../lib/ui/types.js";

/** Status of an individual fetch task. */
type TaskStatus = "pending" | "fetching" | "done" | "error";

/** A fetch task with a label and current status. */
interface ProgressTask {
	label: string;
	status: TaskStatus;
	detail?: string;
}

/** Glyph for each task status. */
const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: GLYPH.pending,
	fetching: GLYPH.active,
	done: GLYPH.complete,
	error: GLYPH.rejected,
};

/** Color for each task status. */
type ThemeColor = "dim" | "accent" | "success" | "error";
const STATUS_COLOR: Record<TaskStatus, ThemeColor> = {
	pending: "dim",
	fetching: "accent",
	done: "success",
	error: "error",
};

/**
 * Configuration for a single fetch task in the progress panel.
 * The `run` function receives an AbortSignal and should return
 * a label suffix (e.g. "12 files, +342 -89") or void.
 */
export interface FetchTask<T> {
	label: string;
	run: (signal: AbortSignal) => Promise<T>;
}

/**
 * Show a live progress panel while running parallel fetch tasks.
 *
 * Returns the results of all tasks in order, or null if the user
 * cancels with Escape. Failed tasks have their errors caught and
 * shown in the panel — the overall flow continues.
 */
export async function showProgress<T extends unknown[]>(
	ctx: ExtensionContext,
	title: string,
	tasks: { [K in keyof T]: FetchTask<T[K]> },
): Promise<T | null> {
	if (!ctx.hasUI) {
		// Non-interactive fallback: run all tasks sequentially
		const results: unknown[] = [];
		const controller = new AbortController();
		for (const task of tasks) {
			results.push(await task.run(controller.signal));
		}
		return results as T;
	}

	const controller = new AbortController();
	const taskStates: ProgressTask[] = tasks.map((t) => ({
		label: t.label,
		status: "pending" as TaskStatus,
	}));
	const results: unknown[] = new Array(tasks.length).fill(undefined);
	let cancelled = false;

	const result = await ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
		// Start all tasks in parallel
		const promises = tasks.map(async (task, i) => {
			const state = taskStates[i];
			if (!state) return;

			state.status = "fetching";
			tui.requestRender();

			try {
				const value = await task.run(controller.signal);
				results[i] = value;
				state.status = "done";

				// Add detail if the result has useful info
				if (typeof value === "string" && value.length > 0) {
					state.detail = value;
				}
			} catch (err) {
				if (controller.signal.aborted) return;
				state.status = "error";
				state.detail = err instanceof Error ? err.message : "Failed";
			}

			tui.requestRender();
		});

		// When all tasks complete, resolve
		Promise.all(promises).then(() => {
			if (!cancelled) {
				done(results as T);
			}
		});

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				cancelled = true;
				controller.abort();
				done(null);
			}
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", GLYPH.hrule.repeat(width)));
			add(` ${theme.fg("accent", theme.bold(title))}`);
			add("");

			for (const task of taskStates) {
				const glyph = STATUS_GLYPH[task.status];
				const color = STATUS_COLOR[task.status];
				const label = task.detail
					? `${task.label} (${task.detail})`
					: task.label;
				add(
					` ${theme.fg(color, glyph)} ${theme.fg(statusTextColor(theme, task.status), label)}`,
				);
			}

			add("");
			add(theme.fg("dim", " Esc cancel"));
			add(theme.fg("accent", GLYPH.hrule.repeat(width)));

			return lines;
		}

		return { render, handleInput };
	});

	return result;
}

/** Map task status to text color — dim for pending, normal for others. */
function statusTextColor(
	_theme: Theme,
	status: TaskStatus,
): "dim" | "text" | "success" | "error" {
	switch (status) {
		case "pending":
			return "dim";
		case "fetching":
			return "text";
		case "done":
			return "success";
		case "error":
			return "error";
	}
}
