/**
 * Which of the person's keys in a window quits pi, as they bound it.
 *
 * Kept apart from the quit asker (`quit-asker.ts`) because it reads
 * pi-tui's keys, and pi-tui is there only inside pi: the asker is
 * reached from code a plain node child loads, as a council's
 * supervisor, and on 25 November that child failed to start for every
 * reviewer once the asker imported pi-tui. So only an extension, which
 * pi loads, imports this.
 */

import {
	getKeybindings,
	isKeyRelease,
	Key,
	matchesKey,
} from "@earendil-works/pi-tui";
import { KEY_QUITS } from "./quit-asker.ts";

/** How close a second ctrl+c must follow the first for pi to quit. */
export const DOUBLE_CLEAR_MS = 500;

/** A key the person pressed in the window, as `keyQuit` reads it. */
export interface Keypress {
	readonly data: string;
	readonly editorText: string;
	readonly atMs: number;
}

/** Does `data` press the keybinding `name`, as the person bound it. */
export type KeyMatcher = (
	data: string,
	name: "app.exit" | "app.clear",
) => boolean;

/** pi's own keybindings, as the person bound them. */
export const boundKeys: KeyMatcher = (data, name) =>
	getKeybindings().matches(data, name);

/**
 * Reads the person's keys for the one that quits pi: the exit key on an
 * empty editor, a second clear key within `DOUBLE_CLEAR_MS`, or enter
 * on `/quit` or the start of it, which pi's autocomplete finishes.
 * Answers who asked, "" for a key that is no quit (which takes a key's
 * ask back), or undefined for a key release, which changes nothing.
 */
export function keyQuit(
	matches: KeyMatcher = boundKeys,
): (press: Keypress) => string | undefined {
	let clearedAtMs: number | undefined;
	return ({ data, editorText, atMs }) => {
		if (isKeyRelease(data)) return undefined;
		if (matches(data, "app.exit") && editorText === "") return KEY_QUITS.exit;
		if (matches(data, "app.clear")) {
			const second =
				clearedAtMs !== undefined && atMs - clearedAtMs <= DOUBLE_CLEAR_MS;
			clearedAtMs = second ? undefined : atMs;
			return second ? KEY_QUITS.clear : "";
		}
		clearedAtMs = undefined;
		if (matchesKey(data, Key.enter) && startsQuit(editorText)) {
			return KEY_QUITS.command;
		}
		return "";
	};
}

/** Whether an editor's text is `/quit`, or a start of it autocomplete finishes. */
function startsQuit(editorText: string): boolean {
	const text = editorText.trim();
	return text.length > 1 && "/quit".startsWith(text);
}
