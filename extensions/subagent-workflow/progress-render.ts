/**
 * Production progress reporter for the fleet.
 *
 * Keeps a snapshot of every subagent's state and shows it two ways:
 *
 * - The status line carries a one-glance summary (`2/3 done pending=1`),
 *   keyed by run, so two fleets in one turn keep two summaries.
 * - A board docked above the editor lists each subagent. The editor keeps
 *   focus, so a person can type a steer or a draft while the fleet runs;
 *   the hop chord reaches the board, where up and down select, `r` cancels
 *   the selected subagent and Escape cancels the fleet, and the same chord
 *   gives the editor back. Escape in the editor is pi's: it stops the
 *   turn, and the turn's signal stops the fleet.
 *
 * The board used to replace the editor, with a listener that swallowed
 * Escape wherever focus was, which is what left a person unable to type
 * anything for as long as a fleet ran.
 *
 * The board stays until `close`, which the tool calls as it returns, so
 * it leaves in the frame its result card arrives. The card opens with the
 * same rows (`fleetCardLines`), which makes it at least as tall as the
 * board was, so the screen neither jumps nor leaves blank rows behind.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { count as grouped } from "@jitsusama/agentic-harness.core/result";
import { AGENT_GLYPH } from "../../lib/ui/agent-glyphs.ts";
import { type Board, boardLines, fitBoard } from "../../lib/ui/board.ts";
import { DOCK_HOP_LABEL, type Docked, dock } from "../../lib/ui/dock.ts";
import type {
	FleetProgress,
	FleetProgressEntry,
	FleetProgressState,
} from "./progress.ts";
import type { FleetRunResult, FleetSubagentResult } from "./run.ts";

const STATUS_KEY = "subagent-workflow:fleet";

/** What the board is called, on screen and on its card. */
const TITLE = "Subagent Fleet";

/** Between the parts of a title. */
const SEPARATOR = " · ";

/** Controls that let the board interrupt subagents. */
export interface FleetProgressControls {
	cancelSubagent(subagentId: string): string;
	cancelAll(): string;
}

/** The observer the orchestrator notifies, plus the call that ends it. */
export interface FleetProgressReporter extends FleetProgress {
	/**
	 * Takes the board and the summary down. Called as the tool returns,
	 * not when the fleet finishes, so the board leaves with its card.
	 */
	close(): void;
}

/**
 * Build a context-bound progress reporter for the fleet `runId`.
 * Returns the observer the orchestrator will notify.
 */
export function createFleetProgressReporter(
	ctx: ExtensionContext,
	controls?: FleetProgressControls,
	runId = "fleet",
): FleetProgressReporter {
	const statusKey = `${STATUS_KEY}:${runId}`;
	let entries: FleetProgressEntry[] = [];
	let selected = 0;
	let notice = "";
	let docked: Docked | undefined;

	// The cursor shows only while the board has the keys, since until
	// then it selects nothing.
	const board = (focused: boolean): Board =>
		fleetBoard(entries, ctx.ui.theme, {
			selected: focused ? selected : -1,
			notice,
		});

	const render = (): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(statusKey, renderFleetStatus(entries, ctx.ui.theme));
		docked?.refresh();
	};

	const act = (data: string, handle: Docked): boolean => {
		const total = entries.length;
		if (matchesKey(data, "up")) {
			selected = total === 0 ? 0 : (selected - 1 + total) % total;
			return true;
		}
		if (matchesKey(data, "down")) {
			selected = total === 0 ? 0 : (selected + 1) % total;
			return true;
		}
		if (matchesKey(data, "escape")) {
			notice = controls?.cancelAll() ?? "Cancellation unavailable.";
			handle.release();
			return true;
		}
		if (data === "r" || data === "R") {
			notice = cancelSelected();
			return true;
		}
		return false;
	};

	const cancelSelected = (): string => {
		const entry = entries[selected];
		if (!entry) return "No subagent selected.";
		if (entry.state !== "running" && entry.state !== "pending")
			return `${entry.spec.id} is already ${entry.state}.`;
		return (
			controls?.cancelSubagent(entry.spec.id) ?? "Cancellation unavailable."
		);
	};

	const show = (): void => {
		if (docked !== undefined) return;
		const theme = ctx.ui.theme;
		docked = dock(ctx, statusKey, {
			render: (width, focused) =>
				boardLines(board(focused), theme, width, focused),
			fit: (_lines, rows, width, focused) =>
				fitBoard(board(focused), theme, width, focused, rows),
			handleInput: act,
		});
	};

	const close = (): void => {
		if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
		docked?.close();
		docked = undefined;
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
			show();
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
			// The board stays until `close`: the tool has more to do before
			// it returns, and the board leaving now would leave the rows it
			// held blank until the card arrives.
			render();
		},
		close,
	};
}

/** How a board is drawn at this moment. */
interface BoardState {
	readonly selected: number;
	readonly notice: string;
}

/**
 * The fleet as a board: one row per subagent, a failure's reason under
 * them. Exported so tests can assert what the rows say without a terminal.
 */
export function fleetBoard(
	entries: readonly FleetProgressEntry[],
	theme: Theme,
	state: BoardState = { selected: -1, notice: "" },
): Board {
	const done = entries.filter((one) => one.state === "complete").length;
	return {
		title: `${theme.fg("accent", theme.bold(TITLE))}${SEPARATOR}${done}/${entries.length} done`,
		aside:
			state.notice === ""
				? theme.fg("dim", `${DOCK_HOP_LABEL} to manage`)
				: theme.fg("warning", state.notice),
		keys: theme.fg(
			"dim",
			`↑/↓ select · r cancel selected · Esc cancel fleet · ${DOCK_HOP_LABEL} back to the editor`,
		),
		rows: entries.map((entry, index) =>
			entryLine(entry, theme, index === state.selected),
		),
		selected: state.selected,
		notes: failureNotes(
			entries.map((entry) => ({
				id: entry.spec.id,
				failed: entry.state === "failed",
				reason: entry.error,
			})),
			theme,
		),
	};
}

/**
 * The result card: the board's rows as the fleet ended, then where the
 * full output lives, and with `expanded` each subagent's own file.
 *
 * The same rows as the board, and one more, so a card is never shorter
 * than the board it replaces: a shorter card would leave the difference
 * as blank rows at the bottom of the screen.
 */
export function fleetCardLines(
	result: FleetRunResult,
	theme: Theme,
	expanded: boolean,
): string[] {
	const entries = result.results.map(entryFromResult);
	const done = entries.filter((one) => one.state === "complete").length;
	const tally = [`${done}/${entries.length} done`];
	const failed = entries.filter((one) => one.state === "failed").length;
	const cancelled = entries.filter((one) => one.state === "cancelled").length;
	if (failed > 0) tally.push(theme.fg("error", `${failed} failed`));
	if (cancelled > 0) tally.push(`${cancelled} cancelled`);
	if (result.totalUsage) {
		tally.push(
			`${grouped(result.totalUsage.tokens.total)} tokens, $${result.totalUsage.cost.total.toFixed(4)}`,
		);
	}
	const lines = [
		[theme.fg("accent", theme.bold(TITLE)), ...tally].join(SEPARATOR),
		...entries.map((entry) => entryLine(entry, theme, false)),
		...failureNotes(
			result.results.map((one) => ({
				id: one.id,
				failed: one.state === "failed",
				reason: one.error ?? "unknown failure",
			})),
			theme,
		),
		theme.fg(
			"dim",
			`  full output: ${result.runDir ?? "not recorded for this run"}`,
		),
	];
	if (expanded) {
		for (const one of result.results) {
			if (one.resultPath)
				lines.push(theme.fg("dim", `    ${one.id} → ${one.resultPath}`));
		}
	}
	return lines;
}

/**
 * Whether a tool result's details are a fleet's result, which is what the
 * card draws. Anything else (an error, a result from an older version of
 * this tool) is drawn as its text.
 */
export function isFleetRunResult(details: unknown): details is FleetRunResult {
	if (typeof details !== "object" || details === null) return false;
	const results: unknown = Reflect.get(details, "results");
	return (
		Array.isArray(results) &&
		results.every(
			(one: unknown) =>
				typeof one === "object" &&
				one !== null &&
				typeof Reflect.get(one, "id") === "string" &&
				typeof Reflect.get(one, "state") === "string",
		)
	);
}

/** A settled result as the board's entry for it. */
function entryFromResult(result: FleetSubagentResult): FleetProgressEntry {
	return {
		spec: { id: result.id },
		state: result.state,
		warnings: result.warnings,
		error: result.error ?? "",
		activity: "",
		...(result.usage ? { usage: result.usage } : {}),
	};
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

/** One reason line per failure, since a reason is too long for its row. */
function failureNotes(
	rows: readonly { id: string; failed: boolean; reason: string }[],
	theme: Theme,
): string[] {
	return rows
		.filter((one) => one.failed && one.reason.length > 0)
		.map((one) =>
			theme.fg("error", `  ${AGENT_GLYPH.failed} ${one.id}: ${one.reason}`),
		);
}

/** One subagent on one row: cursor, state, name, model, what it is doing. */
function entryLine(
	entry: FleetProgressEntry,
	theme: Theme,
	selected: boolean,
): string {
	const cursor = selected ? "▸" : " ";
	const activity = widgetSubtext(entry);
	const model = entry.spec.model ? ` · ${entry.spec.model}` : "";
	const suffix = activity ? ` · ${activity}` : "";
	const line = `${cursor} ${entryStatus(entry, theme)} ${entry.spec.id}${model}${suffix}`;
	return selected ? theme.fg("accent", line) : line;
}

function widgetSubtext(entry: FleetProgressEntry): string | undefined {
	if (entry.state === "complete") {
		if (entry.usage) {
			return `${grouped(entry.usage.tokens.total)} tokens`;
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

/**
 * One row's mark and word, coloured by what it means.
 *
 * The marks are the shared set's, not this file's. They used to be
 * spelled here, and two of them were quest's: a pending subagent drawn
 * as a sidequest and a running one as a subquest, which is the exact
 * collision the ownership gate exists to catch and which it never saw,
 * because this file was not in its list.
 */
function entryStatus(entry: FleetProgressEntry, theme: Theme): string {
	switch (entry.state) {
		case "pending":
			return theme.fg("muted", `${AGENT_GLYPH.pending} pending`);
		case "running":
			return theme.fg("accent", `${AGENT_GLYPH.running} running`);
		case "complete":
			return theme.fg("success", `${AGENT_GLYPH.done} complete`);
		case "cancelled":
			return theme.fg("dim", `${AGENT_GLYPH.cancelled} cancelled`);
		case "failed":
			return theme.fg("error", `${AGENT_GLYPH.failed} failed`);
	}
}
