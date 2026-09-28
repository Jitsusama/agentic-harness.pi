/**
 * Widgets above a live editor, and the one owner that shares the room
 * among them.
 *
 * A fleet and a review round used to show their progress by replacing the
 * editor with a panel, and to catch Escape with a listener that swallowed
 * it wherever focus was. While either ran, nobody could type: not a steer,
 * not a note for later, not even a draft of the next question. So progress
 * now docks above the editor as a widget, the editor keeps focus, and a
 * person who wants the widget's keys hops into it with one chord and back
 * out with the same one. Escape in the editor is pi's again, which stops
 * the turn, and so the work the turn was waiting on.
 *
 * The owner exists because widgets share the terminal with each other and
 * with the transcript. Each frame it asks pi's layout how many rows are
 * left once everything that can still change is on screen, and deals them
 * out in stacking order, so a ticking widget shrinks rather than pushing a
 * running tool's row off the top and forcing pi to replay the whole
 * transcript (see `pi-layout.ts`). A widget below its natural height is
 * asked how to fit, so it can keep its header and the selected row.
 *
 * The widgets are kept on a process-global key for the gate queue's
 * reason: two packages that each carry this library still share one
 * screen, so they must share one list or each would hand out the whole
 * room. The first copy to load installs the list; every later copy joins
 * it, whatever version installed it.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	isKeyRelease,
	isKeyRepeat,
	type KeyId,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { focusedIn, roomForDock } from "./pi-layout.ts";

/**
 * The chord that moves focus between the editor and the topmost widget.
 *
 * Chosen against pi's own bindings and the terminal's: Ctrl+Alt+N is bound
 * by neither, reaches pi from both the kitty protocol and a legacy
 * terminal, and survives the terminal multiplexers the harness is used
 * under. The editor reaches it through pi's shortcut table; a focused
 * widget reaches it here, since pi only consults that table while its own
 * editor has focus.
 */
export const DOCK_HOP_KEY: KeyId = "ctrl+alt+n";

/** How the chord is written for a person reading a footer. */
export const DOCK_HOP_LABEL = "Ctrl+Alt+N";

const DOCK_KEY = Symbol.for("agentic-harness.dock");

/** The protocol version this copy installs. */
const PROTOCOL_VERSION = 1;

/**
 * The share of the terminal a widget may take when pi's layout cannot be
 * read. Half leaves the transcript's tail on screen in every layout seen.
 */
const FALLBACK_SHARE = 0.5;

/** Keys that keep acting while held, since holding them is how you scroll. */
const REPEATABLE: readonly KeyId[] = ["up", "down", "pageUp", "pageDown"];

/** Keys that can move focus out of a widget, whose repeats must not follow. */
const FOCUS_MOVERS: readonly KeyId[] = ["escape", "enter", DOCK_HOP_KEY];

/** One widget, as every copy of this library sees it. */
interface DockEntry {
	readonly key: string;
	readonly component: Component;
	/** Rows it would show with all the room it wanted. */
	want(width: number): number;
	/** Whether the hop chord can reach it. */
	readonly focusable: boolean;
	focus(): void;
}

/**
 * What every copy agrees on. A later version may add to it but must keep
 * these, since an older copy reads them.
 */
interface DockProtocol {
	readonly version: number;
	/** Every widget, in stacking order, which is mount order. */
	entries: DockEntry[];
	/** Where focus goes back to: the editor it came from. */
	editor: Component | undefined;
	/** A focus-moving key whose repeats are swallowed until its release. */
	swallow: KeyId | undefined;
}

function shared(): DockProtocol {
	const g = globalThis as Record<symbol, unknown>;
	const found = g[DOCK_KEY];
	if (isDock(found)) return found;
	const made: DockProtocol = {
		version: PROTOCOL_VERSION,
		entries: [],
		editor: undefined,
		swallow: undefined,
	};
	g[DOCK_KEY] = made;
	return made;
}

function isDock(value: unknown): value is DockProtocol {
	if (typeof value !== "object" || value === null) return false;
	return (
		typeof Reflect.get(value, "version") === "number" &&
		Array.isArray(Reflect.get(value, "entries"))
	);
}

/** What a widget shows and which keys it answers. */
export interface DockBody {
	/** Its rows with all the room it wants, drawn focused or not. */
	render(width: number, focused: boolean): string[];
	/**
	 * Its rows when only `rows` fit, fewer than it wanted. Defaults to the
	 * first `rows`, which cuts a list off at the bottom; a body with a
	 * header and a selection will want to keep both.
	 */
	fit?(
		lines: string[],
		rows: number,
		width: number,
		focused: boolean,
	): string[];
	/**
	 * A key, while the widget has focus. The hop chord, Ctrl+C and Ctrl+D
	 * never arrive: the dock answers those. Return false for a key that
	 * is not the body's.
	 */
	handleInput?(data: string, dock: Docked): boolean;
}

/** A docked widget, as its owner holds it. */
export interface Docked {
	/** Draws it again, after its state changed. */
	refresh(): void;
	/** Gives it the keyboard. */
	focus(): void;
	/** Gives the keyboard back to the editor, if it has it. */
	release(): void;
	/** Whether it has the keyboard. */
	focused(): boolean;
	/** How many rows it showed in the last frame. */
	shownRows(): number;
	/** Takes it off the screen, handing focus back if it had it. */
	close(): void;
	/** Whether it has gone, closed by its owner or cleared by pi. */
	readonly gone: boolean;
}

/** How a widget behaves. */
export interface DockOptions {
	/**
	 * Which held keys keep acting. A progress widget acts on a held key
	 * once, so only navigation repeats; something typed into wants them all.
	 */
	readonly repeats?: "navigation" | "all";
	/** Called once if pi takes the widget away (a reload or a new session). */
	readonly onGone?: () => void;
}

/** A widget that is never drawn, for a session with no terminal. */
const NOWHERE: Docked = {
	refresh() {},
	focus() {},
	release() {},
	focused: () => false,
	shownRows: () => 0,
	close() {},
	gone: true,
};

/**
 * Mounts `body` above the editor under `key` and returns its handle.
 *
 * The editor keeps focus. With no terminal to draw on (print, JSON or RPC
 * mode, or no UI at all) nothing is mounted and the handle is inert, so a
 * caller need not ask first.
 */
export function dock(
	ctx: ExtensionContext,
	key: string,
	body: DockBody,
	options: DockOptions = {},
): Docked {
	if (!ctx.hasUI || ctx.mode !== "tui") return NOWHERE;
	const owner = shared();
	let tui: TUI | undefined;
	let gone = false;
	let shown = 0;
	let unsubscribe: (() => void) | undefined;

	const isFocused = (): boolean =>
		tui !== undefined && focusedIn(tui) === component;

	const streaming = (): boolean => {
		try {
			return ctx.signal !== undefined;
		} catch {
			// A context whose session has been replaced throws on every
			// read; nothing can be streaming in a session that has gone.
			return false;
		}
	};

	const handle: Docked = {
		refresh: () => tui?.requestRender(),
		focus: () => {
			if (gone || tui === undefined || isFocused()) return;
			const current = focusedIn(tui);
			if (!owner.entries.some((one) => one.component === current))
				owner.editor = current ?? undefined;
			tui.setFocus(component);
			tui.requestRender();
		},
		release: () => {
			if (tui === undefined || !isFocused()) return;
			tui.setFocus(owner.editor ?? findEditor(tui));
			tui.requestRender();
		},
		focused: isFocused,
		shownRows: () => shown,
		close: () => {
			if (gone) return;
			const had = isFocused();
			leave();
			// Pi disposes the component here; `leave` has already run, so
			// dispose finds nothing left to do.
			ctx.ui.setWidget(key, undefined);
			if (had && tui !== undefined) {
				tui.setFocus(owner.editor ?? findEditor(tui));
				tui.requestRender();
			}
		},
		get gone() {
			return gone;
		},
	};

	const leave = (): void => {
		gone = true;
		owner.entries = owner.entries.filter((one) => one.component !== component);
		unsubscribe?.();
		unsubscribe = undefined;
	};

	const component: Component & { dispose(): void } = {
		render(width) {
			if (tui === undefined) return [];
			const focused = isFocused();
			const lines = body.render(width, focused);
			let rows = allot(owner, entry, width);
			// A widget with the keyboard never vanishes: keys going into
			// something nobody can see is worse than one redraw.
			if (focused) rows = Math.max(rows, Math.min(1, lines.length));
			const fitted =
				rows >= lines.length
					? lines
					: rows <= 0
						? []
						: (body.fit?.(lines, rows, width, focused) ?? lines.slice(0, rows));
			const out = fitted
				.slice(0, Math.max(rows, 0))
				.map((line) => clean(line, width));
			shown = out.length;
			return out;
		},
		handleInput(data) {
			// Pi's, whichever widget has focus: Ctrl+C clears or quits and
			// Ctrl+D quits, and a widget must not be where they stop working.
			if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
				(owner.editor ?? (tui ? findEditor(tui) : undefined))?.handleInput?.(
					data,
				);
				return;
			}
			if (
				(options.repeats ?? "navigation") === "navigation" &&
				isKeyRepeat(data) &&
				!REPEATABLE.some((name) => matchesKey(data, name))
			)
				return;
			if (isKeyRelease(data)) return;
			if (matchesKey(data, DOCK_HOP_KEY)) handle.release();
			else body.handleInput?.(data, handle);
			// A key that took focus away keeps repeating into whatever has
			// it now, which for Escape is pi's editor, where it stops the turn.
			if (!isFocused()) {
				owner.swallow = FOCUS_MOVERS.find((name) => matchesKey(data, name));
			}
			tui?.requestRender();
		},
		invalidate() {},
		dispose() {
			// Pi clearing its widgets: a reload, or a session replaced.
			if (gone) return;
			const had = isFocused();
			leave();
			if (had && tui !== undefined) tui.setFocus(findEditor(tui));
			options.onGone?.();
		},
	};

	const entry: DockEntry = {
		key,
		component,
		want: (width) => body.render(width, isFocused()).length,
		focusable: body.handleInput !== undefined,
		focus: () => handle.focus(),
	};

	const room = (width: number): number => {
		if (tui === undefined) return 0;
		const ours = new Set(owner.entries.map((one) => one.component));
		return (
			roomForDock(tui, width, ours, streaming()) ??
			Math.floor(tui.terminal.rows * FALLBACK_SHARE)
		);
	};
	roomOf.set(component, room);

	ctx.ui.setWidget(key, (given: TUI, _theme: Theme) => {
		tui = given;
		return component;
	});
	if (tui === undefined) return NOWHERE;
	owner.entries = [...owner.entries.filter((one) => one.key !== key), entry];
	unsubscribe = ctx.ui.onTerminalInput((data) => swallowRepeat(owner, data));
	return handle;
}

/** Each mounted component's way of asking for the room this frame. */
const roomOf = new WeakMap<Component, (width: number) => number>();

/**
 * Rows for `me`: the room, dealt out in stacking order, each widget
 * taking what it wants from what is left.
 */
function allot(owner: DockProtocol, me: DockEntry, width: number): number {
	const room = roomOf.get(me.component);
	let left = room ? room(width) : Number.POSITIVE_INFINITY;
	for (const one of owner.entries) {
		const give = Math.min(one.want(width), left);
		if (one === me) return give;
		left -= give;
	}
	return 0;
}

/**
 * Consumes the repeats and the release of a key that moved focus out of a
 * widget, and lets everything else through.
 */
function swallowRepeat(
	owner: DockProtocol,
	data: string,
): { consume: true } | undefined {
	const held = owner.swallow;
	if (held === undefined) return undefined;
	if (matchesKey(data, held) && (isKeyRepeat(data) || isKeyRelease(data))) {
		if (isKeyRelease(data)) owner.swallow = undefined;
		return { consume: true };
	}
	owner.swallow = undefined;
	return undefined;
}

/**
 * Moves focus from the editor into the topmost widget that takes keys,
 * for the hop chord's shortcut. Does nothing when there is none.
 */
export function hopIntoDock(): void {
	shared()
		.entries.find((one) => one.focusable)
		?.focus();
}

/** Whether any widget that takes keys is docked, in any copy. */
export function dockHasFocusable(): boolean {
	return shared().entries.some((one) => one.focusable);
}

/** Pi's editor, found in the tree when focus never came from it. */
function findEditor(tui: TUI): Component | null {
	const walk = (component: Component): Component | undefined => {
		if (isEditor(component)) return component;
		const children = Reflect.get(component, "children");
		if (!Array.isArray(children)) return undefined;
		for (const child of children) {
			const found = walk(child);
			if (found) return found;
		}
		return undefined;
	};
	for (const child of tui.children) {
		const found = walk(child);
		if (found) return found;
	}
	return null;
}

/** An editor, by the surface pi's editor slot requires. */
function isEditor(component: Component): boolean {
	return (
		typeof Reflect.get(component, "getText") === "function" &&
		typeof Reflect.get(component, "setText") === "function" &&
		typeof Reflect.get(component, "handleInput") === "function"
	);
}

/**
 * A sequence that moves the cursor or scrolls. Built from the escape
 * character rather than written with it inline, which is how the rest of
 * this package spells a control character in a pattern.
 */
const CURSOR_MOVE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*[ABCDEFGHJKSTfsu]`,
	"g",
);

/**
 * One row, made safe to hand pi: no line breaks, no cursor movement, no
 * wider than the terminal. A row that breaks any of these puts pi's idea
 * of the screen out of step with the screen, and every later frame is
 * drawn against the wrong rows.
 */
function clean(line: string, width: number): string {
	const flat = line
		.replaceAll(CURSOR_MARKER, "")
		.replace(/[\r\n]/g, " ")
		.replace(CURSOR_MOVE, "");
	return truncateToWidth(flat, width);
}
