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
import { findEditor, focusedIn, roomForDock } from "./pi-layout.ts";

/**
 * The chord that moves focus from the editor through every widget that
 * takes keys, one press each, and back to the editor.
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

/**
 * The chord pressed `presses` times, as a footer says it: "Ctrl+Alt+N",
 * "Ctrl+Alt+N twice", "Ctrl+Alt+N 3 times".
 */
export function hopLabel(presses: number): string {
	if (presses <= 1) return DOCK_HOP_LABEL;
	if (presses === 2) return `${DOCK_HOP_LABEL} twice`;
	return `${DOCK_HOP_LABEL} ${presses} times`;
}

/** Where a widget sits in the hop's walk, for its footer. */
export interface HopPlace {
	/**
	 * Presses of the chord that bring the keyboard here from wherever it
	 * is now: 0 while this widget has it.
	 */
	readonly presses: number;
	/**
	 * What the next press reaches from here, by its name ("fleet",
	 * "round", "gate"), or undefined for the editor.
	 */
	readonly next: string | undefined;
}

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
	/**
	 * What another widget's footer calls it when the hop goes on to it.
	 * Absent from a copy older than the walk, which never names one.
	 */
	readonly name?: string;
	/**
	 * Whether it is a gate, which is dealt its rows and reached by the hop
	 * before any progress widget. Absent from a copy older than gates, which
	 * never mounts one.
	 */
	readonly gate?: boolean;
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
	/**
	 * When a key last arrived, for a gate deciding whether the person is
	 * mid-sentence. Absent until a copy that watches keys has seen one.
	 */
	lastTyped?: number;
	/**
	 * Whether pi has announced that the session is about to be replaced, so
	 * a gate its teardown closes leaves no record in a transcript that is
	 * about to be rebuilt without it.
	 */
	replacing?: boolean;
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
	/**
	 * Its rows when `room` is what is left for it, however many it wants,
	 * for a body that decides its own height: a gate holds its height and
	 * fills its share rather than be cut to it. When present it is used in
	 * place of `render` and `fit`, for the rows shown and the rows wanted.
	 */
	layout?(room: number, width: number, focused: boolean): string[];
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
	/** Where it sits in the hop's walk now, for its footer. */
	hop(): HopPlace;
	/** Takes it off the screen, handing focus back if it had it. */
	close(): void;
	/** Whether it has gone, closed by its owner or cleared by pi. */
	readonly gone: boolean;
	/** The screen it is drawn on, once pi has mounted it. */
	readonly tui: TUI | undefined;
	/** What pi holds of it, for a caller measuring the screen around it. */
	readonly component: Component | undefined;
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
	/**
	 * A gate: dealt its rows and reached by the hop before every progress
	 * widget, and kept to at least one row, since a question nobody can see
	 * is worse than one row taken from the transcript.
	 */
	readonly gate?: boolean;
	/** Called when the hop chord moves the keyboard into it, or out of it. */
	readonly onHop?: (into: boolean) => void;
	/** Called after each frame it drew rows in, with the width drawn at. */
	readonly onPaint?: (width: number) => void;
	/**
	 * What another widget's footer calls it when the hop goes on to it:
	 * "fleet", "round", "gate". Defaults to "next".
	 */
	readonly name?: string;
}

/** A widget that is never drawn, for a session with no terminal. */
const NOWHERE: Docked = {
	refresh() {},
	focus() {},
	release() {},
	focused: () => false,
	shownRows: () => 0,
	hop: () => ({ presses: 0, next: undefined }),
	close() {},
	gone: true,
	tui: undefined,
	component: undefined,
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
	if (!drawsToTerminal(ctx)) return NOWHERE;
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
		hop: () => placeIn(owner, entry, tui),
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
		get tui() {
			return tui;
		},
		get component() {
			return component;
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
			if (body.layout !== undefined) {
				const laid = body
					.layout(roomLeft(owner, entry, width), width, focused)
					.map((line) => clean(line, width));
				shown = laid.length;
				if (laid.length > 0) options.onPaint?.(width);
				return laid;
			}
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
			if (matchesKey(data, DOCK_HOP_KEY)) {
				options.onHop?.(false);
				after(owner, entry)?.focus();
				// The last widget in the walk, or a next one that could not
				// take the keys: the editor.
				handle.release();
			} else body.handleInput?.(data, handle);
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
		want: (width) =>
			body.layout !== undefined
				? body.layout(roomLeft(owner, entry, width), width, isFocused()).length
				: body.render(width, isFocused()).length,
		focusable: body.handleInput !== undefined,
		// Only the hop reaches a widget through its entry.
		focus: () => {
			handle.focus();
			if (isFocused()) options.onHop?.(true);
		},
		gate: options.gate === true,
		name: options.name,
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
	owner.entries = ranked(
		owner.entries.filter((one) => one.key !== key),
		entry,
	);
	unsubscribe = ctx.ui.onTerminalInput((data) => noteKey(owner, data));
	return handle;
}

/**
 * `entries` with `entry` added: a gate after the gates already up and
 * ahead of every progress widget, anything else at the end. Stacking on
 * screen stays pi's, which is mount order; this is the order rows are
 * dealt in and the hop looks in, so a question outranks a progress bar.
 */
function ranked(entries: DockEntry[], entry: DockEntry): DockEntry[] {
	if (entry.gate !== true) return [...entries, entry];
	const at = entries.findIndex((one) => one.gate !== true);
	if (at < 0) return [...entries, entry];
	return [...entries.slice(0, at), entry, ...entries.slice(at)];
}

/**
 * Watches every key for the session, for the dock: when the last one
 * arrived, and the repeats of a key that moved focus out of a widget,
 * which are swallowed until it is released. Every widget watches while it
 * is up, but a gate needs to know about typing from before it arrived,
 * and a key's repeats outlive the widget it closed, so the lifecycle
 * extension watches for the whole session. Returns the call that stops.
 */
export function watchKeys(ctx: ExtensionContext): () => void {
	if (!drawsToTerminal(ctx)) return () => {};
	return ctx.ui.onTerminalInput((data) => noteKey(shared(), data));
}

/** When a key last arrived, in any copy, or undefined for none yet. */
export function lastKeyAt(): number | undefined {
	return shared().lastTyped;
}

/**
 * Records whether pi has announced a session replace, which the next
 * thing the person or the agent does, or the new session starting,
 * clears: another handler can cancel a replace pi announced.
 */
export function noteReplacing(replacing: boolean): void {
	shared().replacing = replacing;
}

/** Whether a session replace has been announced and not yet undone. */
export function replacing(): boolean {
	return shared().replacing === true;
}

/**
 * Whether pi is drawing this session to a terminal.
 *
 * Read through `Reflect` because a pi older than `mode` still runs this
 * package, whose peer range is open, and its declarations do not have
 * the field. Such a pi said `hasUI` only for its terminal, so there the
 * flag alone answers. Asking for `mode` outright left every board unmounted
 * on those versions rather than drawn.
 */
export function drawsToTerminal(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;
	const mode: unknown = Reflect.get(ctx, "mode");
	return mode === undefined || mode === "tui";
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
 * Rows left for `me` once the widgets dealt before it have taken theirs,
 * however many it wants.
 */
function roomLeft(owner: DockProtocol, me: DockEntry, width: number): number {
	const room = roomOf.get(me.component);
	let left = room ? room(width) : Number.POSITIVE_INFINITY;
	for (const one of owner.entries) {
		if (one === me) return left;
		left -= Math.min(one.want(width), left);
	}
	return 0;
}

/**
 * Notes when a key arrived, then consumes the repeats and the release of
 * a key that moved focus out of a widget, and lets everything else through.
 */
function noteKey(
	owner: DockProtocol,
	data: string,
): { consume: true } | undefined {
	if (!isKeyRelease(data)) owner.lastTyped = Date.now();
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
 * The widgets the hop walks, in the order it walks them: the order rows
 * are dealt in, so gates before progress.
 */
function walk(owner: DockProtocol): DockEntry[] {
	return owner.entries.filter((one) => one.focusable);
}

/** The widget the hop reaches from `me`, or undefined for the editor. */
function after(owner: DockProtocol, me: DockEntry): DockEntry | undefined {
	const stops = walk(owner);
	const at = stops.indexOf(me);
	return at < 0 ? undefined : stops[at + 1];
}

/**
 * Where `me` sits in the hop's walk while the keyboard is wherever `tui`
 * has it. The walk is a loop with the editor as its first stop, and
 * anything else holding the keys counts as the editor, since that is
 * where the chord's shortcut is heard.
 */
function placeIn(
	owner: DockProtocol,
	me: DockEntry,
	tui: TUI | undefined,
): HopPlace {
	const stops = walk(owner);
	const mine = stops.indexOf(me);
	if (mine < 0 || tui === undefined) return { presses: 0, next: undefined };
	const current = focusedIn(tui);
	const holding = stops.findIndex((one) => one.component === current);
	const loop = stops.length + 1;
	const presses = (mine - holding + loop) % loop;
	const next = stops[mine + 1];
	return {
		presses,
		next: next === undefined ? undefined : (next.name ?? "next"),
	};
}

/**
 * Moves focus from the editor into the first widget that takes keys, for
 * the hop chord's shortcut; each widget passes it on to the next, and the
 * last back to the editor. Does nothing when there is none.
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
export function clean(line: string, width: number): string {
	const flat = line
		.replaceAll(CURSOR_MARKER, "")
		.replace(/[\r\n]/g, " ")
		.replace(CURSOR_MOVE, "");
	return truncateToWidth(flat, width);
}
