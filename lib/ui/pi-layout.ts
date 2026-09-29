/**
 * The one place that reads how pi lays its screen out.
 *
 * A widget above the editor shares the terminal with the transcript, and
 * how tall it may be depends on something pi does not publish: which lines
 * of the transcript can still change. Pi repaints the screen by diffing
 * lines, and a line that changes after it has scrolled above the viewport
 * cannot be repainted in place, so pi clears the screen and the scrollback
 * and replays the whole transcript. A ticking widget that pushes a running
 * tool's row off the top therefore flickers the entire session once a tick.
 * The room is what keeps that from happening: the terminal's height, less
 * every other line pi docks around the editor, less every transcript line
 * that can still change.
 *
 * Answering needs pi's component tree and two of its component classes,
 * none of which are pi's public API. The component holding focus and
 * where pi's editor sits in the tree are read here too, for the same
 * reason. They are read here and nowhere else,
 * so a pi that moves them breaks one module, and
 * `tests/screen/pi-layout.test.ts` boots the real pi to say so before a
 * person sees a widget drawn at the wrong height. When the tree is not the
 * shape this expects the answer is `undefined`, and the caller falls back
 * to a fixed share of the terminal rather than guessing.
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** A component that holds others, as pi's containers do. */
interface Holder {
	readonly children: readonly Component[];
}

function holds(value: unknown): value is Holder {
	if (typeof value !== "object" || value === null) return false;
	return Array.isArray(Reflect.get(value, "children"));
}

function rowsOf(components: readonly Component[], width: number): number {
	let rows = 0;
	for (const one of components) rows += one.render(width).length;
	return rows;
}

/** Whether a transcript component can still change. */
function changeable(component: Component): boolean {
	if (!(component instanceof ToolExecutionComponent)) return false;
	// Private in pi's types. Absent reads as running, which only ever
	// makes the room smaller, never a widget taller than it should be.
	return Reflect.get(component, "isPartial") !== false;
}

/**
 * The transcript's own container: the child of the document that holds
 * messages and tool rows. Before the first turn it holds neither, and then
 * the document's last child is it.
 */
function chatOf(document: Holder): (Component & Holder) | undefined {
	const found = document.children.find(
		(child) =>
			holds(child) &&
			child.children.some(
				(one) =>
					one instanceof ToolExecutionComponent ||
					one instanceof AssistantMessageComponent,
			),
	);
	const chat = found ?? document.children[document.children.length - 1];
	return holds(chat) ? chat : undefined;
}

/**
 * Rows the transcript may still change: from the first tool still running
 * to the end, or the message still streaming when no tool is, and a row
 * for each gate's record still giving its rows back. A record counts at
 * the one row it settles at: the rest it gives up to whatever grows below
 * it, in the same frame, so they are room rather than tail.
 */
function changeableTail(
	chat: Holder,
	width: number,
	streaming: boolean,
): number {
	const rows = chat.children;
	let from = rows.findIndex(changeable);
	const last = rows[rows.length - 1];
	if (from < 0 && streaming && last instanceof AssistantMessageComponent)
		from = rows.length - 1;
	const records = rows.filter(settling).length;
	return records + (from < 0 ? 0 : rowsOf(rows.slice(from), width));
}

/**
 * The key a gate's record answers under while it can still shrink. On
 * the process-global registry, so a record one copy of this library left
 * is counted by every other copy's dock.
 */
const SETTLING = Symbol.for("agentic-harness.settling-record");

/** Marks `record` as one that shrinks while `live` says so. */
export function markSettling(record: Component, live: () => boolean): void {
	Reflect.set(record, SETTLING, live);
}

function settling(component: Component): boolean {
	const live: unknown = Reflect.get(component, SETTLING);
	return typeof live === "function" && live() === true;
}

/**
 * Puts `record` into the transcript where a gate's record belongs: before
 * the first tool still running, since that row can still grow and the
 * record must not move once it is down, else at the end. False when the
 * transcript is not laid out the way this reads it, and nothing is put.
 */
export function settleIntoChat(tui: TUI, record: Component): boolean {
	const [document] = tui.children;
	if (!holds(document)) return false;
	const chat = chatOf(document);
	if (chat === undefined) return false;
	// The children are pi's own array, which is how a container is added
	// to; a copy would put the record nowhere.
	const rows = Reflect.get(chat, "children");
	if (!Array.isArray(rows)) return false;
	const at = rows.findIndex(changeable);
	if (at < 0) rows.push(record);
	else rows.splice(at, 0, record);
	return true;
}

/**
 * Rows drawn below `record` down to the top of the dock: the rest of its
 * transcript, and whatever the document holds after the transcript.
 */
export function rowsAfter(tui: TUI, record: Component, width: number): number {
	const [document] = tui.children;
	if (!holds(document)) return 0;
	const chat = document.children.find(
		(child) => holds(child) && child.children.includes(record),
	);
	if (chat === undefined || !holds(chat)) return 0;
	const at = chat.children.indexOf(record);
	const later = document.children.slice(document.children.indexOf(chat) + 1);
	return rowsOf(chat.children.slice(at + 1), width) + rowsOf(later, width);
}

/** Rows of everything pi docks around the editor, `except` left out. */
export function dockRows(tui: TUI, width: number, except?: Component): number {
	let rows = 0;
	for (const part of tui.children.slice(1)) {
		if (part === except) continue;
		if (except !== undefined && holds(part) && part.children.includes(except))
			rows += rowsOf(
				part.children.filter((one) => one !== except),
				width,
			);
		else rows += part.render(width).length;
	}
	return rows;
}

/**
 * Rows a gate's record would have below it if it went down now: from the
 * first tool still running to the transcript's end, what the document
 * holds after it, and the dock, the gate itself left out. Taken while the
 * gate draws, it is what the frame being painted shows, which is what the
 * record's first frame has to match row for row.
 */
export function rowsUnderGate(
	tui: TUI,
	width: number,
	gate: Component,
): number | undefined {
	const [document] = tui.children;
	if (!holds(document)) return undefined;
	const chat = chatOf(document);
	if (chat === undefined) return undefined;
	const at = chat.children.findIndex(changeable);
	const tail = at < 0 ? 0 : rowsOf(chat.children.slice(at), width);
	const later = document.children.slice(document.children.indexOf(chat) + 1);
	return tail + rowsOf(later, width) + dockRows(tui, width, gate);
}

function isComponent(value: unknown): value is Component {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "render") === "function"
	);
}

/**
 * The component holding the keyboard, or null for none.
 *
 * Pi's TUI answers this, but its published interface does not declare the
 * method, only the class behind it does, so it is read here with the rest
 * of what pi does not publish. A TUI that stops answering reads as nothing
 * focused, which leaves a widget unable to take the keys rather than
 * taking them from something it cannot see.
 */
export function focusedIn(tui: TUI): Component | null {
	const read: unknown = Reflect.get(tui, "getFocusedComponent");
	if (typeof read !== "function") return null;
	const focused: unknown = read.call(tui);
	return isComponent(focused) ? focused : null;
}

/**
 * Pi's editor, found in its component tree, for when focus never came
 * from it and the keys still have to go back to it. Null when the tree
 * holds no editor this recognises.
 */
export function findEditor(tui: TUI): Component | null {
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
export function isEditor(component: Component): boolean {
	return (
		typeof Reflect.get(component, "getText") === "function" &&
		typeof Reflect.get(component, "setText") === "function" &&
		typeof Reflect.get(component, "handleInput") === "function"
	);
}

/**
 * Rows the dock may give its own widgets this frame, or `undefined` when
 * pi's screen is not laid out the way this reads it.
 *
 * `ours` are the dock's own components, left out of the count because they
 * are what the room is being worked out for. `streaming` says a turn is in
 * flight, so a message at the end of the transcript can still grow.
 */
export function roomForDock(
	tui: TUI,
	width: number,
	ours: ReadonlySet<Component>,
	streaming: boolean,
): number | undefined {
	const [document, ...docked] = tui.children;
	if (!holds(document)) return undefined;
	const chat = chatOf(document);
	if (chat === undefined) return undefined;
	let chrome = 0;
	for (const part of docked) {
		if (holds(part) && part.children.some((one) => ours.has(one))) {
			chrome += rowsOf(
				part.children.filter((one) => !ours.has(one)),
				width,
			);
		} else chrome += part.render(width).length;
	}
	const tail = changeableTail(chat, width, streaming);
	return Math.max(0, tui.terminal.rows - chrome - tail);
}
