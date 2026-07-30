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
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
	type AskProgress,
	type AskProgressEntry,
	type AskRound,
	trackAskProgress,
} from "../../lib/review/index.js";
import {
	type PipelineStage,
	renderPipelineProgressLines,
	type StageState,
} from "../../lib/ui/index.js";

/** Ours alone, so clearing it cannot clear somebody else's. */
const STATUS_KEY = "review-ask-progress";

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
 * Geometry, not emoji, per the review tools' convention: a filled
 * diamond has answered, a half one is working, an open one is waiting
 * and a cross has failed.
 */
const GLYPH: Record<AskProgressEntry["state"], string> = {
	pending: "\u25c7",
	running: "\u25c8",
	answered: "\u25c6",
	failed: "\u2715",
};

/** How a participant's state reads to the shared pipeline renderer. */
function stageState(state: AskProgressEntry["state"]): StageState {
	switch (state) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "answered":
			return "complete";
		case "failed":
			return "failed";
	}
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
	return entry.reason === undefined || entry.reason === ""
		? undefined
		: entry.reason;
}

/** The one line: who is where, and what the busiest one is doing. */
function summary(
	round: AskRound,
	entries: readonly AskProgressEntry[],
): string {
	const board = entries.map((one) => GLYPH[one.state]).join("");
	const answered = entries.filter((one) => one.state === "answered").length;
	const failed = entries.filter((one) => one.state === "failed").length;
	const parts = [`${round} ${board} ${answered}/${entries.length}`];
	if (failed > 0) parts.push(`${failed} failed`);
	const busy = entries.find(
		(one) => one.state === "running" && one.activity !== "",
	);
	if (busy) parts.push(`${busy.participantId}: ${busy.activity}`);
	return parts.join("  ");
}

/** The panel body, which is the part a status line cannot hold. */
export function panelLines(
	round: AskRound,
	entries: readonly AskProgressEntry[],
	theme: Theme,
	selected = -1,
): string[] {
	if (entries.length === 0) return [];
	const stages: PipelineStage[] = entries.map((entry, index) => ({
		// The selected one is marked in its label rather than by colour, so
		// it still reads on a terminal that has dropped the styling.
		label:
			index === selected ? `${entry.participantId} ◀` : entry.participantId,
		state: stageState(entry.state),
		...(subtext(entry) === undefined ? {} : { subtext: subtext(entry) }),
	}));
	const lines = [
		theme.fg("accent", `${round}, ${entries.length} participants`),
		...renderPipelineProgressLines(stages, theme, { vertical: true }),
	];
	for (const entry of entries) {
		if (entry.state === "failed" && entry.reason) {
			lines.push(
				theme.fg("error", `  \u2715 ${entry.participantId}: ${entry.reason}`),
			);
		}
	}
	// Said plainly, because a panel that can stop work has to say so.
	lines.push(
		theme.fg(
			"muted",
			"up/down to select · r to cancel one · esc to cancel all",
		),
	);
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
		);
		if (this.notice !== "") lines.push(this.theme.fg("warning", this.notice));
		return lines.map((line) =>
			line.length > width
				? `${line.slice(0, Math.max(0, width - 1))}\u2026`
				: line,
		);
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

	const draw = (): void => {
		if (!ctx?.hasUI) return;
		const rows = entries();
		if (rows.length === 0) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("muted", summary(round, rows)),
		);
		panel?.setEntries(rows);
	};

	const teardown = (): void => {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
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
