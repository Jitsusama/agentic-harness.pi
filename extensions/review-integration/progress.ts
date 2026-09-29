/**
 * A round, while it runs, as something you can watch and stop.
 *
 * The first version of this drew one status line and called that enough,
 * on the reasoning that the defect was silence and one line ends silence.
 * That was wrong twice over. Silence was only the first complaint: the
 * next two are not knowing *which* participant is still working, and not
 * being able to stop a round you have reconsidered. A status line answers
 * neither, because it has room for one participant's activity and no room
 * at all for a key binding.
 *
 * So a round is a board docked above the editor, listing every
 * participant, its state and what it is doing. The editor keeps focus, so
 * a person can type while a round runs; the hop chord reaches the board,
 * where up and down select, `r` cancels one participant and Escape the
 * round, and the same chord gives the editor back. Escape in the editor is
 * pi's: it stops the turn, and the turn's signal stops the round.
 *
 * The board used to replace the editor, with a listener that swallowed
 * Escape wherever focus was, so nothing could be typed for as long as a
 * council ran, which is a quarter of an hour on a good day.
 *
 * Cancellation is real here rather than cosmetic. Three separate comments
 * in this extension once claimed pi hands a tool's execute no cancellation
 * signal; the signature is `execute(toolCallId, params, signal, onUpdate,
 * ctx)` and it always had one. The subagent runner already kills a child
 * on abort, so the only thing missing was passing the signal down.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	type AskProgress,
	type AskProgressEntry,
	type AskRound,
	trackAskProgress,
} from "@jitsusama/agentic-harness.core/review";
import { AGENT_GLYPH } from "../../lib/ui/agent-glyphs.ts";
import {
	type Board,
	boardLines,
	fitBoard,
	hopOnward,
	reachBoard,
} from "../../lib/ui/board.ts";
import { type Docked, dock, type HopPlace } from "../../lib/ui/dock.ts";
import type { Answer } from "./tools/shared.ts";

/**
 * The spawned-work set, not the review family, and that is the point. A
 * reviewer in a round and a subagent in a fan-out are the same thing seen
 * from two tools, so they are drawn the same way and the marks live in
 * neither surface.
 *
 * These were diamonds first, which quests own: a round drawn in quest glyphs
 * put seven reviewers on screen looking like seven subquests. They were then
 * review's own triangles, which meant a running participant and a finding
 * wore the same mark, and a panel of seven could be read as seven findings.
 */
const GLYPH: Record<AskProgressEntry["state"], string> = {
	pending: AGENT_GLYPH.pending,
	running: AGENT_GLYPH.running,
	answered: AGENT_GLYPH.done,
	cancelled: AGENT_GLYPH.cancelled,
	failed: AGENT_GLYPH.failed,
};

/** Between the parts of a title or a row. */
const SEPARATOR = " \u00b7 ";

/** The glyph and the word for it, coloured by what it means. */
function status(entry: AskProgressEntry, theme: Theme): string {
	switch (entry.state) {
		case "pending":
			return theme.fg("muted", `${GLYPH.pending} pending`);
		case "running":
			return theme.fg("accent", `${GLYPH.running} running`);
		case "answered":
			return theme.fg("success", `${GLYPH.answered} answered`);
		case "cancelled":
			// Dim rather than red. Somebody stopping a reviewer is not the
			// round going wrong, and it used to paint in success green.
			return theme.fg("dim", `${GLYPH.cancelled} cancelled`);
		case "failed":
			return theme.fg("error", `${GLYPH.failed} failed`);
	}
}

/** One participant on one line: where it is, who it is, what it is doing. */
function participantLine(
	entry: AskProgressEntry,
	theme: Theme,
	selected: boolean,
	shared: string | undefined,
	now: number,
): string {
	const cursor = selected ? "▸" : " ";
	const model =
		entry.model === undefined || entry.model === shared
			? ""
			: `${SEPARATOR}${entry.model}`;
	const said = subtext(entry, now);
	const tail = said === undefined ? "" : `${SEPARATOR}${said}`;
	const line = `${cursor} ${status(entry, theme)} ${entry.participantId}${model}${tail}`;
	return selected ? theme.fg("accent", line) : line;
}

/** How often the elapsed clock on a running row is redrawn. */
const TICK_MS = 1000;

/**
 * How long this row has been at it, said the way a person reads a
 * clock rather than as a duration in milliseconds.
 *
 * Absent until it has started, and frozen once it settles: a finished
 * reviewer's time is a fact about the round, not a counter that should
 * keep climbing.
 */
function elapsed(entry: AskProgressEntry, now: number): string | undefined {
	if (entry.startedAtMs === undefined) return undefined;
	const ms = (entry.settledAtMs ?? now) - entry.startedAtMs;
	if (ms < 0) return undefined;
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes === 0 ? `${seconds}s` : `${minutes}m${seconds % 60}s`;
}

/** What to say under a participant's name. */
function subtext(entry: AskProgressEntry, now: number): string | undefined {
	const since = elapsed(entry, now);
	const took = since === undefined ? "" : `${SEPARATOR}${since}`;
	if (entry.state === "answered") {
		const count = entry.findings;
		if (count === undefined) return `answered${took}`;
		return `${count} ${count === 1 ? "finding" : "findings"}${took}`;
	}
	if (entry.state === "running") {
		return `${entry.activity === "" ? "in flight" : entry.activity}${took}`;
	}
	if (entry.state === "pending") return "queued";
	// Nothing for a failure: the reason gets its own line under the rows,
	// where there is room for it, and saying it in both places printed it
	// twice.
	return undefined;
}

/**
 * The model, when saying it per row would tell you something.
 *
 * A roster is usually one strong model wearing several personas, and
 * repeating its name down seven rows is noise that crowds out the activity
 * beside it. Said once in the title instead. When the models differ it is
 * the opposite: which model is answering is then the most interesting thing
 * on the row, so each row carries its own.
 */
function sharedModel(entries: readonly AskProgressEntry[]): string | undefined {
	const first = entries[0]?.model;
	if (first === undefined) return undefined;
	return entries.every((one) => one.model === first) ? first : undefined;
}

/** How a board is drawn at this moment. */
export interface RoundBoardState {
	/** The row holding the cursor, or -1 for none. */
	readonly selected: number;
	/** The last thing the board said, such as who was cancelled. */
	readonly notice: string;
	/** The instant every running row's clock is read at. */
	readonly now: number;
	/** Where the board sits in the hop's walk, for its footer. */
	readonly hop?: HopPlace;
}

/** The title: the round, its tally, and the model when all share one. */
function roundTitle(
	round: AskRound,
	entries: readonly AskProgressEntry[],
	theme: Theme,
): string {
	const answered = entries.filter((one) => one.state === "answered").length;
	const shared = sharedModel(entries);
	const parts = [
		theme.fg("accent", theme.bold(round)),
		`${answered}/${entries.length} answered`,
		...(shared === undefined ? [] : [shared]),
	];
	return parts.join(SEPARATOR);
}

/** A failure's reason, which is too long for its row. */
function failureNotes(
	entries: readonly AskProgressEntry[],
	theme: Theme,
): string[] {
	return entries
		.filter((entry) => entry.state === "failed" && entry.reason)
		.map((entry) =>
			theme.fg(
				"error",
				`  ${GLYPH.failed} ${entry.participantId}: ${entry.reason}`,
			),
		);
}

/**
 * The round as a board: one row per participant, a failure's reason under
 * them. Exported so tests can assert what the rows say without a terminal.
 */
export function roundBoard(
	round: AskRound,
	entries: readonly AskProgressEntry[],
	theme: Theme,
	state: RoundBoardState = { selected: -1, notice: "", now: Date.now() },
): Board {
	const shared = sharedModel(entries);
	return {
		title: roundTitle(round, entries, theme),
		aside:
			state.notice === ""
				? theme.fg("dim", reachBoard(state.hop))
				: theme.fg("warning", state.notice),
		keys: theme.fg(
			"dim",
			`↑/↓ select · r cancel selected · Esc cancel round · ${hopOnward(state.hop)}`,
		),
		rows: entries.map((entry, index) =>
			participantLine(
				entry,
				theme,
				index === state.selected,
				shared,
				state.now,
			),
		),
		selected: state.selected,
		notes: failureNotes(entries, theme),
	};
}

/** A round's board as it stood when the round's call returned. */
export interface RoundSnapshot {
	readonly round: AskRound;
	readonly entries: readonly AskProgressEntry[];
	/** When it was taken, so a running row's clock stops there. */
	readonly at: number;
}

/**
 * The rows a round's answer opens with: its board as it ended, without
 * the rule and the keys, which belonged to something live.
 *
 * The answer's own text follows, so a card is at least a row taller than
 * the rows here and never shorter than the board it replaces, focused or
 * not: a shorter card would leave the difference as blank rows at the
 * foot of the screen.
 */
export function roundCardLines(
	snapshot: RoundSnapshot,
	theme: Theme,
): string[] {
	const shared = sharedModel(snapshot.entries);
	return [
		roundTitle(snapshot.round, snapshot.entries, theme),
		...snapshot.entries.map((entry) =>
			participantLine(entry, theme, false, shared, snapshot.at),
		),
		...failureNotes(snapshot.entries, theme),
	];
}

/** How many watches this process has opened, which keys each board. */
let watches = 0;

/** What the board can stop. */
interface RoundControls {
	all(): void;
	one(participantId: string): string;
}

/** What a reporter hands back, so a caller can both watch and stop. */
export interface RoundWatch {
	readonly round: AskRound;
	readonly progress: AskProgress;
	/** Tripped when the whole round is cancelled. */
	readonly signal: AbortSignal;
	/**
	 * One participant's own signal, so cancelling it leaves the others
	 * running. Derived from the round's, so cancelling everything still
	 * reaches each of them.
	 */
	signalFor(participantId: string): AbortSignal;
	/**
	 * Stop one participant and say so on its row.
	 *
	 * What the board's `r` key does, here rather than inside the board so
	 * that stopping a reviewer can be driven without a terminal to press
	 * the key in. Returns the notice to show.
	 */
	cancelOne(participantId: string): string;
	/**
	 * Stop the whole round and mark every row that had not settled.
	 *
	 * What Escape on the board does, here for the same reason: it is the
	 * commoner of the two ways a round is stopped and there was no way to
	 * drive it without a terminal.
	 */
	cancelAll(): void;
	/**
	 * The rows as they stand, which is what the board is drawing.
	 *
	 * Read by cancellation to decide what is still stoppable, so this is
	 * the watch's own view of the round rather than a window opened for
	 * a test to look through.
	 */
	entries(): AskProgressEntry[];
	/** The rows as they stand, to go with the round's answer. */
	snapshot(): RoundSnapshot;
	/**
	 * Takes the board down. Called as the round's call returns rather than
	 * when the round finishes, so the board leaves with the answer.
	 */
	close(): void;
}

/**
 * Watch a round: a board, and signals that its keys trip.
 *
 * Reporting is best-effort by construction. With no UI attached every
 * draw is a no-op, because a round must not depend on being watched, and
 * the signals still work so a headless caller keeps cancellation.
 */
export function watchRound(
	round: AskRound,
	ctx: ExtensionContext | null,
	outer?: AbortSignal,
): RoundWatch {
	const { progress, entries } = trackAskProgress();
	const whole = new AbortController();
	const each = new Map<string, AbortController>();

	// Pi's own signal still cancels, so a round stops when the turn does.
	// Without this the board would be the only way out of something the
	// session has already abandoned.
	outer?.addEventListener("abort", () => whole.abort(), { once: true });

	const signalFor = (id: string): AbortSignal => {
		const held = each.get(id);
		if (held) return held.signal;
		const made = new AbortController();
		each.set(id, made);
		if (whole.signal.aborted) made.abort();
		else
			whole.signal.addEventListener("abort", () => made.abort(), {
				once: true,
			});
		return made.signal;
	};

	let docked: Docked | undefined;
	let selected = 0;
	let notice = "";
	// Redrawing on events alone would freeze the clock on exactly the
	// participant worth watching: one that has gone quiet emits nothing,
	// so its row would sit at the elapsed time of its last word while
	// the minutes it is actually costing go unreported.
	let tick: ReturnType<typeof setInterval> | undefined;

	// The board and nothing else. The status bar is for what stays true
	// across a session, and the board is titled with the same round, the
	// same tally and the same shared model a status line would write. Two
	// copies of one fact is not twice the reassurance: it costs the one line
	// the whole harness shares, so a loaded quest and a disabled git
	// interception have to compete with a transient.
	const draw = (): void => {
		docked?.refresh();
	};

	const stopTicking = (): void => {
		// Unconditional. A timer outlives the thing it was drawing for, so
		// leaving it running because there is no UI to draw on is how a
		// round that ended keeps a handle alive for the rest of the session.
		if (tick !== undefined) clearInterval(tick);
		tick = undefined;
	};

	const cancelOne = (participantId: string): string => {
		// A row that already settled is not cancellable. Pressing the key
		// on a reviewer that has answered would otherwise rewrite it as
		// cancelled and take its findings count off the board, which is
		// destroying the result rather than stopping the work.
		const row = entries().find((one) => one.participantId === participantId);
		if (row !== undefined && row.state !== "pending" && row.state !== "running")
			return `${participantId} already ${row.state}`;
		signalFor(participantId);
		each.get(participantId)?.abort();
		// Said on the row as well as in the notice. The notice is one line
		// that the next one replaces, so without this the only record of
		// the kill vanished and the row went on to paint itself answered,
		// in success green, whatever had actually happened to it.
		progress.cancelled(participantId);
		draw();
		return `cancelled ${participantId}`;
	};

	const controls: RoundControls = {
		all() {
			whole.abort();
			// Every row that had not settled, not merely the signal. Escape
			// is the commoner of the two ways to stop a round and it marked
			// nothing at all, so the state added for exactly this was
			// reachable only one participant at a time, and a round somebody
			// abandoned still painted itself as one that answered.
			for (const row of entries()) {
				if (row.state === "pending" || row.state === "running")
					progress.cancelled(row.participantId);
			}
			// Give the keyboard back at once. The round will settle on its
			// own, and waiting for it would strand the person meanwhile.
			docked?.release();
			draw();
		},
		one: (participantId) => cancelOne(participantId),
	};

	const act = (data: string): boolean => {
		const total = entries().length;
		if (matchesKey(data, Key.up)) {
			selected = total === 0 ? 0 : (selected - 1 + total) % total;
			return true;
		}
		if (matchesKey(data, Key.down)) {
			selected = total === 0 ? 0 : (selected + 1) % total;
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			controls.all();
			return true;
		}
		// One participant, by the letter its own line names, so a round
		// with one wedged reviewer does not have to be abandoned whole.
		if (data === "r" || data === "R") {
			const one = entries()[selected];
			if (one !== undefined) notice = controls.one(one.participantId);
			return true;
		}
		return false;
	};

	const install = (): void => {
		if (ctx === null || !ctx.hasUI || docked !== undefined) return;
		const theme = ctx.ui.theme;
		// Read once per draw rather than per row, so every row of one round
		// is measured against the same instant. The cursor shows only while
		// the board has the keys, since until then it selects nothing.
		const board = (focused: boolean): Board =>
			roundBoard(round, entries(), theme, {
				selected: focused ? selected : -1,
				notice,
				now: Date.now(),
				hop: docked?.hop(),
			});
		// Keyed per watch, not per kind of round: two councils in one turn
		// are two boards, and pi replaces a widget whose key comes round again.
		docked = dock(
			ctx,
			`review-integration:round:${round}:${++watches}`,
			{
				render: (width, focused) =>
					boardLines(board(focused), theme, width, focused),
				fit: (_lines, rows, width, focused) =>
					fitBoard(board(focused), theme, width, focused, rows),
				handleInput: (data) => act(data),
			},
			{ name: "round" },
		);
		tick = setInterval(draw, TICK_MS);
		// Never hold the process open for a redraw. A round is worth
		// waiting for; the clock next to it is not.
		tick.unref?.();
	};

	return {
		round,
		signal: whole.signal,
		signalFor,
		cancelOne,
		cancelAll: () => {
			controls.all();
		},
		entries,
		snapshot: () => ({ round, entries: entries(), at: Date.now() }),
		close: () => {
			stopTicking();
			docked?.close();
			docked = undefined;
		},
		progress: {
			start(participants) {
				progress.start(participants);
				install();
				draw();
			},
			started(id) {
				progress.started(id);
				draw();
			},
			activity(id, what) {
				progress.activity(id, what);
				draw();
			},
			answered(id) {
				progress.answered(id);
				draw();
			},
			cancelled(id) {
				progress.cancelled(id);
				draw();
			},
			failed(id, reason) {
				progress.failed(id, reason);
				draw();
			},
			recorded(id, findings) {
				progress.recorded(id, findings);
				draw();
			},
			finish() {
				progress.finish();
				// The clock stops, since every row has settled or never will.
				// The board stays until `close`: the call has more to do before
				// it returns, and the board leaving now would leave the rows it
				// held blank until the answer arrives.
				stopTicking();
				draw();
			},
		},
	};
}

/**
 * Answer a call that may open rounds, and take their boards down with it.
 *
 * `answer` is handed `watch`, which opens a round's board; every board it
 * opened closes as the answer is handed back, whatever the answer was and
 * however it was reached, and the answer carries each board's last state
 * so its card can open with the same rows.
 *
 * Settling in one place is the point. Every round ends by telling its
 * progress it has finished, and none of them do it from a finally: a round
 * that threw once left the editor replaced and a timer repainting the
 * board once a second for the rest of the session.
 */
export async function answerWatching(
	ctx: ExtensionContext | null,
	signal: AbortSignal | undefined,
	answer: (watch: (round: AskRound) => RoundWatch) => Promise<Answer>,
): Promise<Answer> {
	const opened: RoundWatch[] = [];
	const watch = (round: AskRound): RoundWatch => {
		const made = watchRound(round, ctx, signal);
		opened.push(made);
		return made;
	};
	try {
		return withBoards(await answer(watch), opened);
	} finally {
		for (const made of opened) {
			made.progress.finish();
			made.close();
		}
	}
}

/** The answer, carrying the last state of every round that drew a board. */
function withBoards(answer: Answer, opened: readonly RoundWatch[]): Answer {
	const boards = opened
		.map((made) => made.snapshot())
		.filter((one) => one.entries.length > 0);
	if (boards.length === 0) return answer;
	const details =
		typeof answer.details === "object" && answer.details !== null
			? answer.details
			: {};
	return { ...answer, details: { ...details, boards } };
}

/** The boards an answer carries, when its details hold any. */
export function boardsOf(details: unknown): RoundSnapshot[] {
	if (typeof details !== "object" || details === null) return [];
	const boards: unknown = Reflect.get(details, "boards");
	if (!Array.isArray(boards)) return [];
	return boards.filter(isSnapshot);
}

function isSnapshot(value: unknown): value is RoundSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const entries: unknown = Reflect.get(value, "entries");
	return (
		typeof Reflect.get(value, "round") === "string" &&
		typeof Reflect.get(value, "at") === "number" &&
		Array.isArray(entries) &&
		entries.every(
			(one: unknown) =>
				typeof one === "object" &&
				one !== null &&
				typeof Reflect.get(one, "participantId") === "string" &&
				typeof Reflect.get(one, "state") === "string",
		)
	);
}
