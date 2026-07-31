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
 * So this restores what the older surface had: a panel in the prompt area
 * listing every participant, its state and what it is doing, with the
 * status line kept beside it as the one-glance summary. Escape cancels.
 *
 * Cancellation is real here rather than cosmetic, which it could not be
 * before. Three separate comments in this extension claimed pi hands a
 * tool's execute no cancellation signal; the signature is
 * `execute(toolCallId, params, signal, onUpdate, ctx)` and it always had
 * one. The subagent runner already kills a child on abort, so the only
 * thing missing was passing the signal down.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type AskProgress,
	type AskProgressEntry,
	type AskRound,
	trackAskProgress,
} from "../../lib/review/index.js";
import { GLYPH as REVIEW_GLYPH } from "./render.js";

/**
 * How long one participant gets before it is treated as wedged.
 *
 * The runner's own default is forty-five minutes, which is a sensible
 * ceiling for a long autonomous job and absurd for this: a reviewer
 * reads a diff and writes findings, and a council round is minutes.
 *
 * This used to be justified by there being no other way to stop a round.
 * That was never true, and the panel now cancels on Escape, so the bound
 * is doing a narrower job: it catches a participant that stops responding
 * while nobody is watching the panel, and turns "wedged until someone
 * notices" into a failure with a reason the round already knows how to
 * report.
 *
 * Fifteen minutes is roughly six times the longest round observed, so it
 * does not truncate honest work.
 */
export const PARTICIPANT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Geometry, not emoji, per the review tools' convention: triangles, since
 * that is the review surface's family, and a participant in a round is part
 * of a review. An open one is waiting, a small one is working, a filled one
 * has answered and a cross has failed.
 *
 * These were diamonds, which quests own. A round drawn in quest glyphs put
 * seven reviewers on screen looking like seven subquests.
 */
const GLYPH: Record<AskProgressEntry["state"], string> = {
	// The shared set's mark for accepted but not finished. A participant not yet
	// run and a change sitting in a merge queue are the same fact about
	// different subjects, so they are the same mark, spelled in one place.
	pending: REVIEW_GLYPH.queued,
	running: "\u25b8",
	answered: "\u25b6",
	// Taken from the shared set rather than spelled again, so the panel and the
	// recorded answer cannot disagree about what a failed participant looks like.
	failed: REVIEW_GLYPH.failed,
};

/** The glyph and the word for it, coloured by what it means. */
function status(entry: AskProgressEntry, theme: Theme): string {
	switch (entry.state) {
		case "pending":
			return theme.fg("muted", `${GLYPH.pending} pending`);
		case "running":
			return theme.fg("accent", `${GLYPH.running} running`);
		case "answered":
			return theme.fg("success", `${GLYPH.answered} answered`);
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
): string {
	const cursor = selected ? "▸" : " ";
	const model =
		entry.model === undefined || entry.model === shared
			? ""
			: ` · ${entry.model}`;
	const said = subtext(entry);
	const tail = said === undefined ? "" : ` · ${said}`;
	const line = `${cursor} ${status(entry, theme)} ${entry.participantId}${model}${tail}`;
	return selected ? theme.fg("accent", line) : line;
}

/** What to say under a participant's name. */
function subtext(entry: AskProgressEntry): string | undefined {
	if (entry.state === "answered") {
		const count = entry.findings;
		if (count === undefined) return "answered";
		return `${count} ${count === 1 ? "finding" : "findings"}`;
	}
	if (entry.state === "running") {
		return entry.activity === "" ? "in flight" : entry.activity;
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

/**
 * The panel body, which is the part a status line cannot hold.
 *
 * Composed here rather than handed to `renderPipelineProgressLines`. That
 * is the widget renderer, and reaching for it because it was already
 * imported produced a stack of two-line stages where the old panel drew
 * one line per reviewer inside a frame. A panel is a different shape of
 * thing from a widget: it takes the whole prompt area, so it is framed and
 * titled, and each row has room for a name, a model and an activity side
 * by side.
 */
export function panelLines(
	round: AskRound,
	entries: readonly AskProgressEntry[],
	theme: Theme,
	selected = -1,
	width = 80,
): string[] {
	if (entries.length === 0) return [];
	const rule = theme.fg("accent", "─".repeat(Math.max(1, width)));
	const answered = entries.filter((one) => one.state === "answered").length;
	const shared = sharedModel(entries);
	const title =
		`${round} · ${answered}/${entries.length} answered` +
		(shared === undefined ? "" : ` · ${shared}`);
	const lines = [
		rule,
		` ${theme.fg("accent", theme.bold(title))}`,
		` ${theme.fg("dim", "↑/↓ select · r cancel selected · esc cancel round")}`,
		"",
	];
	for (const [index, entry] of entries.entries()) {
		lines.push(participantLine(entry, theme, index === selected, shared));
	}
	// A reason gets its own line under the rows: it is the one thing here
	// long enough that squeezing it onto a row would truncate it away.
	for (const entry of entries) {
		if (entry.state === "failed" && entry.reason) {
			lines.push(
				theme.fg(
					"error",
					`   ${GLYPH.failed} ${entry.participantId}: ${entry.reason}`,
				),
			);
		}
	}
	lines.push(rule);
	return lines;
}

/**
 * The prompt-area panel: the part a status line cannot hold.
 *
 * It replaces the prompt editor while a round runs, which is what makes
 * the keys available: a panel that only drew would leave Escape belonging
 * to the editor behind it. That means implementing pi's editor surface,
 * and most of it is deliberately inert here, because this is a display
 * that borrows the keyboard rather than somewhere to type.
 */
class RoundPanel {
	borderColor?: (str: string) => string;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	private entries: readonly AskProgressEntry[];
	private selected = 0;
	private notice = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly round: AskRound,
		entries: readonly AskProgressEntry[],
		private readonly cancel: RoundControls,
	) {
		this.entries = entries;
	}

	setEntries(entries: readonly AskProgressEntry[]): void {
		this.entries = entries;
		if (this.selected >= entries.length) this.selected = 0;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = panelLines(
			this.round,
			this.entries,
			this.theme,
			this.selected,
			width,
		);
		if (this.notice !== "") {
			lines.push(` ${this.theme.fg("warning", this.notice)}`);
		}
		// pi's own truncation, which counts what a terminal shows rather than
		// what a string holds. Every line here carries colour escapes, and
		// slicing by length cuts inside one, which spills the styling across
		// the rest of the screen.
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selected =
				(this.selected - 1 + this.entries.length) % this.entries.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = (this.selected + 1) % this.entries.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.cancel.all();
			return;
		}
		// One participant, by the letter its own line names, so a round
		// with one wedged reviewer does not have to be abandoned whole.
		if (data === "r" || data === "R") {
			const one = this.entries[this.selected];
			if (one === undefined) return;
			this.notice = this.cancel.one(one.participantId);
			this.tui.requestRender();
		}
	}

	// Pi's editor surface, inert by design: nothing here is typed into.
	getText(): string {
		return "";
	}
	setText(_text: string): void {}
	addToHistory(_text: string): void {}
	insertTextAtCursor(_text: string): void {}
	getExpandedText(): string {
		return "";
	}
	setAutocompleteProvider(_provider: unknown): void {}
	setPaddingX(_padding: number): void {}
	setAutocompleteMaxVisible(_maxVisible: number): void {}
	invalidate(): void {}
}

/** What the panel can stop. */
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
}

/**
 * Watch a round: status line, panel, and signals that the panel trips.
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
	// Without this the panel would be the only way out of something the
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

	let panel: RoundPanel | null = null;
	let previousEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let unsubscribe: (() => void) | undefined;
	let installed = false;

	// The panel and nothing else. The status bar is for what stays true across
	// a session, and a round in flight already owns the editor area, titled
	// with the same round, the same tally and the same shared model the status
	// line was writing. Two copies of one fact is not twice the reassurance:
	// it costs the one line the whole harness shares, so a loaded quest and a
	// disabled git interception have to compete with a transient.
	const draw = (): void => {
		if (!ctx?.hasUI) return;
		const rows = entries();
		if (rows.length === 0) return;
		panel?.setEntries(rows);
	};

	const teardown = (): void => {
		if (!ctx?.hasUI) return;
		unsubscribe?.();
		unsubscribe = undefined;
		// Restoring the editor must not depend on the round still being
		// alive: if it died first, the person still needs the keyboard back.
		if (installed) ctx.ui.setEditorComponent(previousEditor);
		installed = false;
		previousEditor = undefined;
		panel = null;
	};

	const controls: RoundControls = {
		all() {
			whole.abort();
			// Give the keyboard back at once. The round will settle on its
			// own, and waiting for it would strand the person meanwhile.
			teardown();
		},
		one(participantId) {
			signalFor(participantId);
			each.get(participantId)?.abort();
			return `cancelled ${participantId}`;
		},
	};

	const install = (): void => {
		if (!ctx?.hasUI || installed) return;
		previousEditor = ctx.ui.getEditorComponent();
		const theme = ctx.ui.theme;
		ctx.ui.setEditorComponent((tui) => {
			panel = new RoundPanel(tui, theme, round, entries(), controls);
			return panel as unknown as ReturnType<
				NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>
			>;
		});
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) return undefined;
			controls.all();
			return { consume: true };
		});
		installed = true;
	};

	return {
		round,
		signal: whole.signal,
		signalFor,
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
				// The round's own answer is about to say all of this properly,
				// and a stale board outlives the thing it described.
				teardown();
			},
		},
	};
}
