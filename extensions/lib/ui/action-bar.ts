/**
 * ActionBar input handling: Shift+key annotations and
 * Shift+Escape redirect.
 *
 * Rendering is handled by renderFooter in panel-layout.ts.
 * This module handles only the input side: detecting action
 * keys and their Shift variants.
 */

import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { Action } from "./types.js";

/**
 * US keyboard mapping from shifted symbols to their base key.
 *
 * pi-tui's `parseKeyId` uses `+` as the modifier separator
 * (e.g. `"ctrl+c"`), so `matchesKey(data, "+")` always fails;
 * `"+".split("+")` yields an empty key. This map lets us express
 * `+` as `Key.shift("=")` instead, routing around the parser.
 */
const SHIFTED_SYMBOL_BASE: Record<string, string> = {
	"+": "=",
	"!": "1",
	"@": "2",
	"#": "3",
	$: "4",
	"%": "5",
	"^": "6",
	"&": "7",
	"*": "8",
	"(": "9",
	")": "0",
	_: "-",
	"{": "[",
	"}": "]",
	"|": "\\",
	":": ";",
	'"': "'",
	"<": ",",
	">": ".",
	"?": "/",
	"~": "`",
};

/**
 * Match a key that may be a shifted symbol.
 *
 * pi-tui's `parseKeyId` splits on `+` as the modifier separator,
 * so `matchesKey(data, "+")` always returns false: the `+` char
 * parses to an empty key. This helper works around the limitation:
 *
 * 1. Try `matchesKey` directly (works for non-`+` keys).
 * 2. For shifted symbols, try `Key.shift(baseKey)`: catches
 *    Kitty CSI-u sequences where the terminal encodes Shift+=.
 * 3. Fall back to raw character comparison: catches legacy
 *    terminals that send the literal `+` byte.
 */
export function matchesActionKey(data: string, key: string): boolean {
	if (matchesKey(data, key)) return true;
	const baseKey = SHIFTED_SYMBOL_BASE[key];
	if (baseKey) {
		if (matchesKey(data, Key.shift(baseKey))) return true;
		// This is a legacy fallback: some terminals send the raw character (e.g., "+" for Shift+=).
		if (data === key) return true;
	}
	return false;
}

export type ActionBarResult =
	| { type: "action"; key: string }
	| { type: "annotatedAction"; key: string }
	| { type: "redirect" };

/**
 * Handle action bar key input. Returns a result or null if unhandled.
 * Shift+key opens an annotation editor; plain key fires immediately.
 */
export function handleActionInput(
	data: string,
	actions: Action[],
): ActionBarResult | null {
	// Shift+letter = annotated variant of an action
	for (const action of actions) {
		if (matchesKey(data, Key.shift(action.key))) {
			return { type: "annotatedAction", key: action.key };
		}
	}

	// Shift+Escape = redirect (feedback not tied to any action)
	if (matchesKey(data, Key.shift("escape"))) {
		return { type: "redirect" };
	}

	// Plain letter = immediate action
	for (const action of actions) {
		if (matchesActionKey(data, action.key)) {
			return { type: "action", key: action.key };
		}
	}

	return null;
}
