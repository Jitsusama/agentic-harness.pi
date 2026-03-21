/**
 * Progress panel: live-updating view for parallel async tasks.
 *
 * Shows a bordered panel with one line per task. Each task
 * updates independently as its promise resolves, triggering
 * re-renders. The user can cancel with Escape.
 *
 * Returns task results in order, or null if cancelled.
 * Falls back to sequential execution when no UI is available.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { GLYPH } from "./types.js";

// ---- Public types ----

/** A task to run with live progress reporting. */
export interface ProgressTask<T> {
	/** Display label shown in the panel. */
	label: string;
	/** Async work to perform. Receives an AbortSignal for cancellation. */
	run: (signal: AbortSignal) => Promise<T>;
}

/** Configuration for the progress panel. */
export interface ProgressConfig {
	/** Title shown at the top of the panel. */
	title: string;
}

// ---- Public API ----

/**
 * Run parallel tasks with a live progress panel.
 *
 * Each task's status updates in real time as it completes or
 * fails. Returns all results in order, or null if the user
 * cancels with Escape.
 */
export async function progress<T extends unknown[]>(
	ctx: ExtensionContext,
	config: ProgressConfig,
	tasks: { [K in keyof T]: ProgressTask<T[K]> },
): Promise<T | null> {
	if (!ctx.hasUI) {
		return runSequentially(tasks);
	}
	return runWithPanel(ctx, config, tasks);
}

// ---- Sequential fallback ----

/** Run tasks one at a time when no UI is available. */
async function runSequentially<T extends unknown[]>(
	tasks: { [K in keyof T]: ProgressTask<T[K]> },
): Promise<T> {
	const results: unknown[] = [];
	const controller = new AbortController();
	for (const task of tasks) {
		results.push(await task.run(controller.signal));
	}
	return results as T;
}

// ---- Live panel ----

/** Status of a single task in the panel. */
type TaskStatus = "pending" | "running" | "done" | "error";

/** Mutable state for a single task line. */
interface TaskLine {
	label: string;
	status: TaskStatus;
	detail?: string;
}

/** Glyph for each task status. */
const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: GLYPH.pending,
	running: GLYPH.active,
	done: GLYPH.complete,
	error: GLYPH.rejected,
};

/** Theme color for each task status glyph. */
const GLYPH_COLOR: Record<TaskStatus, "dim" | "accent" | "success" | "error"> =
	{
		pending: "dim",
		running: "accent",
		done: "success",
		error: "error",
	};

/** Theme color for each task status label text. */
const LABEL_COLOR: Record<TaskStatus, "dim" | "text" | "success" | "error"> = {
	pending: "dim",
	running: "text",
	done: "success",
	error: "error",
};

/** Show the live progress panel and run all tasks in parallel. */
async function runWithPanel<T extends unknown[]>(
	ctx: ExtensionContext,
	config: ProgressConfig,
	tasks: { [K in keyof T]: ProgressTask<T[K]> },
): Promise<T | null> {
	const controller = new AbortController();
	const taskLines: TaskLine[] = tasks.map((t) => ({
		label: t.label,
		status: "pending" as TaskStatus,
	}));
	const results: unknown[] = new Array(tasks.length).fill(undefined);
	let cancelled = false;

	return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
		const promises = tasks.map(async (task, i) => {
			const line = taskLines[i];
			if (!line) return;

			line.status = "running";
			tui.requestRender();

			try {
				const value = await task.run(controller.signal);
				results[i] = value;
				line.status = "done";
			} catch (err) {
				if (controller.signal.aborted) return;
				line.status = "error";
				line.detail = err instanceof Error ? err.message : "Failed";
			}

			tui.requestRender();
		});

		Promise.all(promises).then(() => {
			if (!cancelled) done(results as T);
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
			add(` ${theme.fg("accent", theme.bold(config.title))}`);
			add("");

			for (const task of taskLines) {
				const glyph = theme.fg(
					GLYPH_COLOR[task.status],
					STATUS_GLYPH[task.status],
				);
				const label = task.detail
					? `${task.label} (${task.detail})`
					: task.label;
				const text = theme.fg(LABEL_COLOR[task.status], label);
				add(` ${glyph} ${text}`);
			}

			add("");
			add(theme.fg("dim", " Esc cancel"));
			add(theme.fg("accent", GLYPH.hrule.repeat(width)));

			return lines;
		}

		return { render, handleInput };
	});
}
