/**
 * ActionBar: key-hint action bar with Shift+key steer annotations.
 *
 * Shows actions with highlighted key shortcuts plus steer hint:
 *   [A]pprove  [R]eject                    ⇧+key to annotate
 *
 * Shift+letter opens a NoteEditor for that action. Shift+S opens
 * a pure steer annotation (no action attached).
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Action } from "./types.js";

// ---- Shifted symbol support ----

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
		// Legacy fallback: terminal sends raw character (e.g. "+" for Shift+=)
		if (data === key) return true;
	}
	return false;
}

// ---- Types ----

export type ActionBarResult =
	| { type: "action"; key: string }
	| { type: "steerAction"; key: string }
	| { type: "pureSteer" };

// ---- Rendering ----

/**
 * Render the action bar with key-hint labels and steer annotation hint.
 */
export function renderActionBar(
	actions: Action[],
	width: number,
	theme: Theme,
	showSteerHint = true,
): string {
	const parts: string[] = [];

	for (const action of actions) {
		parts.push(formatActionLabel(action, theme));
	}

	const left = ` ${parts.join("  ")}`;
	if (!showSteerHint) return truncateToWidth(left, width);

	const hint = theme.fg("dim", "⇧+key annotate · ⇧+Enter feedback");
	return truncateToWidth(`${left}  ${hint}`, width);
}

/**
 * Handle action bar key input. Returns a result or null if unhandled.
 * Shift+key opens an annotation editor; plain key fires immediately.
 */
export function handleActionInput(
	data: string,
	actions: Action[],
): ActionBarResult | null {
	// Shift+letter = steer variant of an action
	for (const action of actions) {
		if (matchesKey(data, Key.shift(action.key))) {
			return { type: "steerAction", key: action.key };
		}
	}

	// Shift+Enter = pure steer (feedback not tied to any action)
	if (matchesKey(data, Key.shift("enter"))) {
		return { type: "pureSteer" };
	}

	// Plain letter = immediate action
	for (const action of actions) {
		if (matchesActionKey(data, action.key)) {
			return { type: "action", key: action.key };
		}
	}

	return null;
}

// ---- Internal helpers ----

/** Format an action label with the key letter highlighted in accent. */
function formatActionLabel(
	action: Action,
	theme: Theme,
	suffix?: string,
): string {
	const label = action.label + (suffix ?? "");
	return formatKeyLabel(action.key, label, theme);
}

/** Format a key-hint label: [K]eyword where K is in accent. */
function formatKeyLabel(key: string, label: string, theme: Theme): string {
	const upperKey = key.toUpperCase();
	const idx = label.toUpperCase().indexOf(upperKey);

	if (idx >= 0) {
		const before = label.slice(0, idx);
		const keyChar = label.slice(idx, idx + 1);
		const after = label.slice(idx + 1);
		return `${before}[${theme.fg("accent", keyChar)}]${after}`;
	}

	// Key not found in label: prefix it
	return `[${theme.fg("accent", upperKey)}] ${label}`;
}
