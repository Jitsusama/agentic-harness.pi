/**
 * A gate docked above a live editor.
 *
 * A gate used to be an overlay: drawn over the transcript it was asking
 * about, over the editor, and holding every key until it was answered, so
 * nobody could type a steer or even read the conversation around the
 * question. Here the same panel, unchanged inside, docks above the editor
 * as a widget. It holds the keyboard, since a gate is a question waiting
 * on its person, and the hop chord moves between it and the editor, with
 * the gate left on screen and anything typed meanwhile kept.
 *
 * Taking the keyboard unasked is where it can go wrong, and three rules
 * keep it from answering a key meant for something else. It takes focus
 * once it has been painted, not once it is mounted, so a key pressed
 * before the person could see it goes where they meant it. It takes focus
 * only from the editor and only once the editor has gone untouched for a
 * moment: measured, a gate taking focus mid-sentence was approved by the
 * Enter meant for the draft at every offset from 0 to 800 ms. And for a
 * moment after it takes focus it ignores Enter and Escape, since a key
 * already on its way was aimed at the editor. Every Enter in that window
 * either sends the draft, which pi delivers after the gate's tool, or
 * reaches the gate unarmed and is dropped with the draft kept. Once the
 * person hops out it stays out until they hop back.
 *
 * Its height follows the dock's room (see `dock.ts`) and never leaves a
 * gap: it holds the rows it has, gives them back only as the room shrinks,
 * and fills whatever it is dealt, padding inside above its bottom rule.
 * Too short for its own layout, it asks the panel to lay itself out in
 * fewer rows, and failing that it shows one row that says it is waiting.
 * Answered, it settles into the transcript as its own record in the same
 * frame (see `gate-record.ts`).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	DOCK_HOP_LABEL,
	type Docked,
	dock,
	hopLabel,
	lastKeyAt,
	replacing,
} from "./dock.ts";
import { settleRecord } from "./gate-record.ts";
import { type PanelRoom, withPanelRoom } from "./panel-room.ts";
import { focusedIn, isEditor, rowsUnderGate } from "./pi-layout.ts";
import { GLYPH } from "./types.ts";

/** How long the editor must go untouched before a gate takes the keyboard. */
export const GATE_TYPING_IDLE_MS = 500;

/** How long after taking the keyboard a gate ignores Enter and Escape. */
export const GATE_ARM_MS = 400;

/**
 * How often a gate that wants the keyboard asks again. Pi's own dialogs
 * hand focus back to the editor when they close without announcing it to
 * a widget, so this is how a gate gets it back after one.
 */
const SETTLE_TICK_MS = 100;

/** Times a panel is asked to lay itself out in fewer rows before giving up. */
const REFIT_TRIES = 3;

/** A disposable panel, as the primitives build one. */
type Panel = Component & { dispose?(): void };

/** What a docked gate is built from: a panel and the call that answers it. */
export type GateFactory<T> = (
	tui: TUI,
	theme: Theme,
	done: (result: T) => void,
) => Panel;

/** How a docked gate behaves, and what it says once answered. */
export interface GateDockOptions<T> {
	/** The answer Escape gives, and every way of closing it from outside. */
	readonly cancelled: T;
	/** What the record says of an answer: "✓ approved", "✗ cancelled". */
	readonly verdict: (result: T) => string;
	/** How the gate names itself in a one-row form. */
	readonly title: string;
	/** Closes it with a record: its turn stopped, or its caller dismissed it. */
	readonly stop: AbortSignal;
	/** Closes it with none: its session ended, and its transcript with it. */
	readonly end: AbortSignal;
}

/** How the gate was laid out in the last frame, to draw its record from. */
interface Shape {
	/** Rows the panel was asked to fit, infinity for its natural height. */
	readonly ask: number;
	/** Whether even its smallest layout would not fit, so one row stood in. */
	readonly oneRow: boolean;
	/** Rows it was padded to. */
	readonly floor: number;
}

let mounted = 0;

/**
 * Docks the panel `factory` builds as a gate, and answers once it is
 * answered or closed. Undefined when pi gave it nowhere to go, for the
 * caller to show it another way.
 */
export function dockGate<T>(
	ctx: ExtensionContext,
	factory: GateFactory<T>,
	options: GateDockOptions<T>,
): Promise<T> | undefined {
	const { stop, end } = options;
	if (stop.aborted || end.aborted) return Promise.resolve(options.cancelled);

	let resolve: (result: T) => void = () => {};
	const answered = new Promise<T>((settle) => {
		resolve = settle;
	});

	const theme = ctx.ui.theme;
	let docked: Docked | undefined;
	let inner: Panel | undefined;
	let finished = false;
	let wantFocus = true;
	let painted = false;
	let armedAt = 0;
	let under: number | undefined;
	let measuring = false;
	let width = 0;
	let held = 0;
	let lastRoom = -1;
	let shape: Shape = { ask: Number.POSITIVE_INFINITY, oneRow: false, floor: 0 };
	let editing: string | undefined;

	/**
	 * The chord as this gate's hints say it: pressed once while the gate
	 * has the keys, else as many times as reach it; and where it goes next.
	 */
	const hop = (focused: boolean): { hop: string; hopTo: string } => {
		const place = docked?.hop();
		return {
			hop: focused
				? DOCK_HOP_LABEL
				: hopLabel(Math.max(1, place?.presses ?? 1)),
			hopTo: place?.next ?? "editor",
		};
	};

	/** The panel drawn at `width`, told it has `allot` rows and why. */
	const draw = (at: number, allot: number, answered = false): string[] => {
		const tui = docked?.tui;
		if (tui === undefined) return [];
		const focused = docked?.focused() ?? false;
		const room: PanelRoom = {
			rows: tui.terminal.rows,
			allot,
			answered,
			...hop(focused),
			focused,
		};
		return withPanelRoom(room, () => {
			inner ??= factory(tui, theme, (result) => answer(result, "key"));
			const lines = inner.render(at);
			if (!answered) editing = room.editing;
			return lines;
		});
	};

	/** What the small form says the gate is: its title, or the note typed. */
	const subject = (): string => editing ?? `${options.title} waiting`;

	/** The keys the small form offers, the way out to the editor first. */
	const hints = (focused: boolean): string => {
		const { hop: chord, hopTo } = hop(focused);
		if (!focused) return `${chord} to answer`;
		if (editing !== undefined)
			return `${chord} ${hopTo} · Enter submit · Esc back`;
		return `${chord} ${hopTo} · Enter answer · Esc cancel`;
	};

	/**
	 * The gate too short for its own layout: what it is and its keys, on
	 * one row with the subject cut to leave the keys whole, or on two with
	 * a rule above when there is room for three.
	 */
	const small = (
		at: number,
		rows: number,
		focused: boolean,
		answered: boolean,
	): string[] => {
		const keys = answered ? "" : hints(focused);
		const what = answered ? options.title : subject();
		if (rows <= 1) {
			const tail = keys === "" ? "" : ` · ${keys}`;
			const room = Math.max(1, at - visibleWidth(tail) - 1);
			return [theme.fg("dim", ` ${truncateToWidth(what, room)}${tail}`)];
		}
		const out = [` ${truncateToWidth(what, Math.max(1, at - 1))}`];
		if (rows >= 3) out.unshift(theme.fg("accent", GLYPH.hrule.repeat(at)));
		return [...out, theme.fg("dim", ` ${keys}`)];
	};

	/** The gate laid out as `shape`, drawn as its record once answered. */
	const drawShape = (
		as: Shape,
		at: number,
		focused: boolean,
		answered = false,
	): string[] => {
		const out = as.oneRow
			? small(at, as.floor, focused, answered)
			: draw(at, as.ask, answered);
		return padTo(out, as.floor);
	};

	/**
	 * The gate in `room` rows: its natural height when that fits, else laid
	 * out again in fewer, else one row. It never shows fewer rows than it
	 * held unless the room itself shrank, and fills what it is dealt.
	 */
	const layout = (room: number, at: number, focused: boolean): string[] => {
		width = at;
		const natural = draw(at, Number.POSITIVE_INFINITY);
		if (lastRoom >= 0 && room < lastRoom)
			held = Math.max(0, held - (lastRoom - room));
		lastRoom = room;
		const cap = Math.max(1, room);
		const floor = Math.min(Math.max(held, Math.min(natural.length, room)), cap);
		let ask = Number.POSITIVE_INFINITY;
		let got = natural.length;
		let fits = got <= cap;
		if (!fits) {
			ask = cap;
			got = draw(at, ask).length;
			for (
				let tries = 0;
				tries < REFIT_TRIES && got > cap && ask > 1;
				tries++
			) {
				ask = Math.max(1, ask - (got - cap));
				got = draw(at, ask).length;
			}
			fits = got <= cap;
		}
		if (fits && got < floor) {
			const more = draw(at, floor).length;
			if (more > got && more <= floor) ask = floor;
		}
		shape = { ask, oneRow: !fits, floor };
		const out = drawShape(shape, at, focused);
		held = out.length;
		return out;
	};

	const settle = (): void => {
		const tui = docked?.tui;
		if (finished || tui === undefined || docked === undefined) return;
		if (docked.gone || !wantFocus || !painted || docked.focused()) return;
		const typed = lastKeyAt();
		if (typed !== undefined && Date.now() - typed < GATE_TYPING_IDLE_MS) return;
		const current = focusedIn(tui);
		if (current === null || !isEditor(current)) return;
		docked.focus();
		armedAt = Date.now() + GATE_ARM_MS;
	};
	const tick = setInterval(settle, SETTLE_TICK_MS);
	tick.unref?.();

	const onStop = (): void => answer(options.cancelled, "stop");
	const onEnd = (): void => answer(options.cancelled, "end");

	/**
	 * Settles the gate once, however it was answered. A key, or its turn
	 * stopping, leaves a record; its session ending, a replace pi has
	 * announced, or pi taking the widget away leaves none, since the
	 * transcript it would sit in is about to be rebuilt without it.
	 */
	function answer(result: T, how: "key" | "stop" | "end" | "gone"): void {
		if (finished) return;
		finished = true;
		clearInterval(tick);
		stop.removeEventListener("abort", onStop);
		end.removeEventListener("abort", onEnd);
		const tui = docked?.tui;
		const record = how === "key" || (how === "stop" && !replacing());
		if (
			record &&
			tui !== undefined &&
			docked?.gone === false &&
			under !== undefined
		) {
			const verdict = options.verdict(result);
			// Its verdict on its last row, in place of the bottom rule, so a
			// record that gives rows back keeps it longest; at one row it says
			// what was decided as well.
			const last = truncateToWidth(` ${theme.fg("muted", verdict)}`, width);
			const one = truncateToWidth(
				` ${theme.fg("muted", `${verdict} · ${options.title}`)}`,
				width,
			);
			const drawn = fitTo(
				drawShape(shape, width, false, true),
				docked.shownRows(),
			);
			settleRecord(tui, [...drawn.slice(0, -1), last], one, under);
		}
		docked?.close();
		try {
			inner?.dispose?.();
		} catch {
			// The panel is off the screen and its answer is in; a dispose
			// that throws has nothing left to leave behind.
		}
		resolve(result);
	}

	docked = dock(
		ctx,
		`agentic-harness.gate.${++mounted}`,
		{
			render: (at) => draw(at, Number.POSITIVE_INFINITY),
			layout,
			handleInput: (data) => {
				if (finished) return true;
				const early = Date.now() < armedAt;
				if (
					early &&
					(matchesKey(data, Key.enter) || matchesKey(data, Key.escape))
				)
					return true;
				const tui = docked?.tui;
				if (tui === undefined || inner === undefined) return true;
				// Against the rows last shown, so a scroll is clamped to the
				// height the person can see rather than the terminal's.
				withPanelRoom(
					{
						rows: tui.terminal.rows,
						allot: shape.ask,
						...hop(true),
						focused: true,
					},
					() => inner?.handleInput?.(data),
				);
				return true;
			},
		},
		{
			gate: true,
			name: "gate",
			repeats: "all",
			onGone: () => answer(options.cancelled, "gone"),
			onHop: (into) => {
				wantFocus = into;
				if (into) armedAt = 0;
			},
			onPaint: (at) => {
				const tui = docked?.tui;
				const component = docked?.component;
				if (!measuring && tui !== undefined && component !== undefined) {
					measuring = true;
					try {
						under = rowsUnderGate(tui, at, component);
					} finally {
						measuring = false;
					}
				}
				if (!painted) {
					painted = true;
					// Once the frame holding it has been written.
					setImmediate(settle);
				}
			},
		},
	);
	if (docked.gone) {
		finished = true;
		clearInterval(tick);
		return undefined;
	}
	stop.addEventListener("abort", onStop, { once: true });
	end.addEventListener("abort", onEnd, { once: true });
	return answered;
}

/** `lines` padded to `rows` inside, above the last row, its bottom rule. */
function padTo(lines: string[], rows: number): string[] {
	if (lines.length >= rows) return lines;
	const blanks = Array.from({ length: rows - lines.length }, () => "");
	return [...lines.slice(0, -1), ...blanks, ...lines.slice(-1)];
}

/** `lines` made exactly `rows` tall, its last row kept. */
function fitTo(lines: string[], rows: number): string[] {
	if (lines.length <= rows) return padTo(lines, rows);
	return [...lines.slice(0, Math.max(0, rows - 1)), ...lines.slice(-1)];
}
