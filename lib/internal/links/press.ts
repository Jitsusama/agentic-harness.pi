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
 * It fails safe to pi's own behaviour: no method of that name, and it
 * installs nothing; a TUI without the fields it reads, and it does
 * nothing; a resolver that throws, and pi's result stands. A mark on
 * the prototype, under a `Symbol.for` key so a reloaded copy of this
 * module finds it, keeps the method wrapped once however often this
 * runs.
 */

/** Reads a link from pi's last screen at a 0-based cell, or nothing. */
export type PressResolver = (
	screen: readonly string[],
	x: number,
	y: number,
	columns: number,
) => string | undefined;

const METHOD = "handleSelectionMouseEvent";
const MARK = Symbol.for("agentic-harness.pi/links/plain-press");

/** The button bits of an SGR mouse report: 0 is the left button. */
const BUTTON_BITS = 3;
/** The bit an SGR mouse report sets for motion, as in a drag. */
const MOTION_BIT = 32;

/** What the mark on the prototype holds: the method it wrapped and who answers now. */
interface Wrap {
	/** pi's own method, put back when the wrap comes off. */
	original: unknown;
	wrapper: (...args: unknown[]) => unknown;
	resolve: PressResolver;
}

/**
 * Wrap pi's press on `prototype` (`TuiAltScreen.prototype`) so a press
 * pi finds no link under is answered by `resolve`. Returns what takes
 * the wrap off again; it does so only while this call's resolver is
 * the one answering, so an older copy's release leaves a newer one's
 * wrap alone.
 */
export function answerPlainPresses(
	prototype: object,
	resolve: PressResolver,
): () => void {
	const existing: unknown = Reflect.get(prototype, MARK);
	if (isWrap(existing)) {
		existing.resolve = resolve;
		return () => unwrap(prototype, existing, resolve);
	}
	const original: unknown = Reflect.get(prototype, METHOD);
	if (typeof original !== "function") return () => {};
	const wrap: Wrap = {
		original,
		wrapper(this: unknown, ...args: unknown[]): unknown {
			const result = Reflect.apply(original, this, args);
			try {
				answer(this, args[0], wrap.resolve);
			} catch {
				// A failed answer is a press pi found no link under, as before.
			}
			return result;
		},
		resolve,
	};
	Object.defineProperty(prototype, MARK, { value: wrap, configurable: true });
	Reflect.set(prototype, METHOD, wrap.wrapper);
	return () => unwrap(prototype, wrap, resolve);
}

function unwrap(prototype: object, wrap: Wrap, resolve: PressResolver): void {
	if (wrap.resolve !== resolve || Reflect.get(prototype, MARK) !== wrap) return;
	if (Reflect.get(prototype, METHOD) === wrap.wrapper) {
		Reflect.set(prototype, METHOD, wrap.original);
	}
	Reflect.deleteProperty(prototype, MARK);
}

function answer(tui: unknown, event: unknown, resolve: PressResolver): void {
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
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "wrapper") === "function" &&
		typeof Reflect.get(value, "resolve") === "function"
	);
}
