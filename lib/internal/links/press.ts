/**
 * The one wrap of pi-tui's fullscreen press, so a click on plain text
 * that names a place opens it as a click on a link does.
 *
 * pi-tui's `TuiAltScreen` answers a left press with its private
 * `handleSelectionMouseEvent`: it reads the OSC 8 link under the cell
 * from the screen it last drew into `pressedUrl`, and when the release
 * lands on the same cell it opens that through `openUrl` instead of
 * starting a selection. pi-tui exports no way to add to that, so this
 * wraps the method on the prototype. After pi's own press, and only
 * when pi found no link, the press was a plain left one, pi is
 * selecting by character and pi anchored the press in a scroll view,
 * the resolver reads the screen and its answer becomes `pressedUrl`;
 * pi's own release then opens it.
 *
 * The scroll view is what keeps it to the transcript. pi's release
 * opens `pressedUrl` before it hands the click to an overlay or a
 * component, so a link set under the prompt being typed, or under a
 * picker, would open where the click should place the cursor or choose
 * the item. pi anchors a press in a scroll view only when no overlay is
 * open, and pi's fullscreen makes only its transcript one. Nothing is
 * drawn differently, so what a selection copies and what the model
 * sees are untouched, and the cost is one read of the screen a click.
 *
 * Given an opener, the wrap also opens every link a click lands on
 * through it, pi's OSC 8 links included: while pi handles the mouse
 * event, the TUI's `openUrl` is the opener, with pi's own as its
 * fallback, and pi's is put back after. That is how a link reaches the
 * terminal, which can bring the app it opens forward
 * (`through-terminal.ts`).
 *
 * It fails safe to pi's own behaviour: no method of that name, and it
 * installs nothing; a TUI without the fields it reads, and it does
 * nothing; a resolver that throws, and pi's result stands. A mark on
 * the prototype, under a `Symbol.for` key so a reloaded copy of this
 * module finds it, keeps the method wrapped once however often this
 * runs.
 *
 * The wrap is the process's, since the prototype is, but who answers
 * belongs to each conversation: its own places and its own opener, kept
 * in its session slot. A host shows several conversations' screens from
 * one process, and hands each viewer's input to its screen inside that
 * conversation's session, so a press reads the answer of the screen
 * pressed. A press with no answer for its conversation is pi's alone.
 */

import { hosted, sessionSlot } from "../../core/session/index.ts";
import type { LinkOpener } from "./through-terminal.ts";

/** Reads a link from pi's last screen at a 0-based cell, or nothing. */
export type PressResolver = (
	screen: readonly string[],
	x: number,
	y: number,
	columns: number,
) => string | undefined;

const METHOD = "handleSelectionMouseEvent";
const MARK = Symbol.for("agentic-harness.pi/links/plain-press");
/** The session slot holding a conversation's answer for each wrapped prototype. */
const ANSWERS = "agentic-harness.pi/links/plain-press/answers";

/** The button bits of an SGR mouse report: 0 is the left button. */
const BUTTON_BITS = 3;
/** The bit an SGR mouse report sets for motion, as in a drag. */
const MOTION_BIT = 32;

/** What the mark on the prototype holds: the method it wrapped and its wrapper. */
interface Wrap {
	/** pi's own method, put back when the wrap comes off. */
	original: unknown;
	wrapper: (...args: unknown[]) => unknown;
	/** Set by every wrap that reads its answer from the session. */
	keyed: true;
}

/** One conversation's answer to a press pi found no link under. */
interface Answer {
	resolve: PressResolver;
	/** What opens a clicked link, when not pi's own opener alone. */
	open: LinkOpener | undefined;
}

/**
 * Wrap pi's press on `prototype` (`TuiAltScreen.prototype`) so a press
 * pi finds no link under, in this conversation, is answered by
 * `resolve`. Returns what takes the answer away again, only while it is
 * still this conversation's, so an older copy's release leaves a newer
 * one's alone. Outside a host it takes the wrap off too; in a host the
 * wrap stays for the other conversations.
 */
export function answerPlainPresses(
	prototype: object,
	resolve: PressResolver,
	open?: LinkOpener,
): () => void {
	const wrap = wrapOf(prototype);
	if (!wrap) return () => {};
	const mine: Answer = { resolve, open };
	answers().set(prototype, mine);
	return () => {
		const held = answers();
		if (held.get(prototype) !== mine) return;
		held.delete(prototype);
		if (!hosted()) unwrap(prototype, wrap);
	};
}

/** This conversation's answers, by the prototype they answer for. */
function answers(): WeakMap<object, Answer> {
	return sessionSlot(ANSWERS, undefined, () => new WeakMap<object, Answer>());
}

/** The answer of the conversation a press arrives in, when it has one. */
function answerHere(prototype: object): Answer | undefined {
	try {
		return answers().get(prototype);
	} catch {
		// A press outside any conversation in a host has nobody to answer
		// it, so it stays pi's own.
		return undefined;
	}
}

/** The wrap on `prototype`, made once, or nothing when pi's press isn't there. */
function wrapOf(prototype: object): Wrap | undefined {
	const existing: unknown = Reflect.get(prototype, MARK);
	if (isWrap(existing)) return existing;
	if (isAnyWrap(existing)) unwrap(prototype, existing);
	const original: unknown = Reflect.get(prototype, METHOD);
	if (typeof original !== "function") return undefined;
	const wrap: Wrap = {
		original,
		wrapper(this: unknown, ...args: unknown[]): unknown {
			const answer = answerHere(prototype);
			const restore = opensThrough(this, answer?.open);
			let result: unknown;
			try {
				result = Reflect.apply(original, this, args);
			} finally {
				restore();
			}
			if (!answer) return result;
			try {
				answerPress(this, args[0], answer.resolve);
			} catch {
				// A failed answer is a press pi found no link under, as before.
			}
			return result;
		},
		keyed: true,
	};
	Object.defineProperty(prototype, MARK, { value: wrap, configurable: true });
	Reflect.set(prototype, METHOD, wrap.wrapper);
	return wrap;
}

function unwrap(
	prototype: object,
	wrap: { original: unknown; wrapper: unknown },
): void {
	if (Reflect.get(prototype, MARK) !== wrap) return;
	if (Reflect.get(prototype, METHOD) === wrap.wrapper) {
		Reflect.set(prototype, METHOD, wrap.original);
	}
	Reflect.deleteProperty(prototype, MARK);
}

/**
 * Make the TUI's `openUrl` go through `open` for one mouse event, pi's
 * own as the fallback, returning what puts pi's back. A TUI with no
 * opener of its own keeps none, so pi opens nothing it wouldn't.
 */
function opensThrough(tui: unknown, open: LinkOpener | undefined): () => void {
	if (!open || typeof tui !== "object" || tui === null) return () => {};
	const own: unknown = Reflect.get(tui, "openUrl");
	if (typeof own !== "function") return () => {};
	const piOpens = (url: string): void => {
		try {
			Reflect.apply(own, tui, [url]);
		} catch {
			// pi treats opening a link as best effort, and so does this.
		}
	};
	Reflect.set(tui, "openUrl", (url: string) => {
		open(url, piOpens).catch(() => piOpens(url));
	});
	return () => Reflect.set(tui, "openUrl", own);
}

function answerPress(
	tui: unknown,
	event: unknown,
	resolve: PressResolver,
): void {
	if (!isPlainLeftPress(event) || typeof tui !== "object" || tui === null)
		return;
	const screen: unknown = Reflect.get(tui, "previousScreen");
	const terminal: unknown = Reflect.get(tui, "terminal");
	if (!Array.isArray(screen) || !screen.every((row) => typeof row === "string"))
		return;
	if (!hasSize(terminal)) return;
	if (Reflect.get(tui, "selectionPressActive") !== true) return;
	if (Reflect.get(tui, "selectionGranularity") !== "character") return;
	if (!("pressedUrl" in tui) || Reflect.get(tui, "pressedUrl") !== undefined)
		return;
	if (!anchorsInScrollView(Reflect.get(tui, "selectionAnchor"))) return;
	const x = clamp(event.x, terminal.columns);
	const y = clamp(event.y, terminal.rows);
	const url = resolve(screen, x, y, terminal.columns);
	if (url) Reflect.set(tui, "pressedUrl", url);
}

interface MouseReport {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

function isPlainLeftPress(event: unknown): event is MouseReport {
	if (typeof event !== "object" || event === null) return false;
	const button: unknown = Reflect.get(event, "button");
	return (
		typeof button === "number" &&
		(button & BUTTON_BITS) === 0 &&
		(button & MOTION_BIT) === 0 &&
		Reflect.get(event, "release") === false &&
		typeof Reflect.get(event, "x") === "number" &&
		typeof Reflect.get(event, "y") === "number"
	);
}

/** Whether pi anchored the press inside a scroll view: its transcript, with no overlay open. */
function anchorsInScrollView(anchor: unknown): boolean {
	return (
		typeof anchor === "object" &&
		anchor !== null &&
		typeof Reflect.get(anchor, "scrollView") === "object" &&
		Reflect.get(anchor, "scrollView") !== null
	);
}

function hasSize(
	terminal: unknown,
): terminal is { columns: number; rows: number } {
	return (
		typeof terminal === "object" &&
		terminal !== null &&
		typeof Reflect.get(terminal, "columns") === "number" &&
		typeof Reflect.get(terminal, "rows") === "number"
	);
}

/** A cell clamped to the screen, as pi clamps it. */
function clamp(cell: number, size: number): number {
	return Math.max(0, Math.min(size - 1, cell));
}

function isWrap(value: unknown): value is Wrap {
	return isAnyWrap(value) && Reflect.get(value, "keyed") === true;
}

/**
 * A wrap any copy of this module made, an earlier one's included, which
 * held one answer for the whole process.
 */
function isAnyWrap(
	value: unknown,
): value is { original: unknown; wrapper: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "wrapper") === "function"
	);
}
