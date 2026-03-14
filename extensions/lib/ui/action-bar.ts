/**
 * ActionBar — key-hint action bar with hold-to-reveal steer layer.
 *
 * Normal state shows actions with highlighted key shortcuts:
 *   [A]pprove  [R]eject                    hold ⇧ to annotate
 *
 * Shift held reveals the steer layer:
 *   [A]pprove + note  [R]eject + note  [S]teer      release ⇧
 *
 * Uses Kitty keyboard protocol (wantsKeyRelease) to detect
 * shift key down/up transitions.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { Action } from "./types.js";

// ---- Types ----

export type ActionBarResult =
	| { type: "action"; key: string }
	| { type: "steerAction"; key: string }
	| { type: "pureSteer" };

// ---- Rendering ----

/**
 * Render the action bar in normal mode.
 * Highlights the key letter in accent color within each label.
 */
export function renderActionBar(
	actions: Action[],
	width: number,
	theme: Theme,
): string {
	const parts: string[] = [];

	for (const action of actions) {
		parts.push(formatActionLabel(action, theme));
	}

	const left = `  ${parts.join("  ")}`;
	const hint = theme.fg("dim", "hold ⇧ to annotate");
	const leftWidth = visibleWidth(left);
	const hintWidth = visibleWidth(hint);
	const gap = Math.max(2, width - leftWidth - hintWidth);

	return truncateToWidth(`${left}${" ".repeat(gap)}${hint}`, width);
}

/**
 * Render the action bar in steer mode (shift held).
 * Each action becomes annotatable, plus a pure Steer option.
 */
export function renderSteerBar(
	actions: Action[],
	width: number,
	theme: Theme,
): string {
	const parts: string[] = [];

	for (const action of actions) {
		parts.push(formatActionLabel(action, theme, " + note"));
	}
	parts.push(formatKeyLabel("s", "Steer", theme));

	const left = `  ${parts.join("  ")}`;
	const hint = theme.fg("dim", "release ⇧");
	const leftWidth = visibleWidth(left);
	const hintWidth = visibleWidth(hint);
	const gap = Math.max(2, width - leftWidth - hintWidth);

	return truncateToWidth(`${left}${" ".repeat(gap)}${hint}`, width);
}

/**
 * Handle action bar key input. Returns a result or null if
 * unhandled. The caller tracks shift state via key release events.
 */
export function handleActionInput(
	data: string,
	actions: Action[],
	shiftHeld: boolean,
): ActionBarResult | null {
	// Shift+S = pure steer (always available)
	if (matchesKey(data, Key.shift("s"))) {
		return { type: "pureSteer" };
	}

	// Shift+letter = steer variant of an action
	for (const action of actions) {
		if (matchesKey(data, Key.shift(action.key))) {
			return { type: "steerAction", key: action.key };
		}
	}

	// Normal letter = immediate action (only when shift not held)
	if (!shiftHeld) {
		for (const action of actions) {
			if (data === action.key) {
				return { type: "action", key: action.key };
			}
		}
	}

	return null;
}

/**
 * Detect shift key press/release transitions for hold-to-reveal.
 * Returns the new shift state, or null if the key wasn't a
 * shift transition.
 */
export function detectShiftTransition(data: string): boolean | null {
	// Kitty protocol sends specific sequences for modifier-only keys.
	// Shift press: CSI 1;2u (key 1, shift modifier)
	// Shift release: CSI 1;2:3u (key 1, shift modifier, release event)
	if (data === "\x1b[1;2u") return true;
	if (data === "\x1b[1;2:3u") return false;
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

	// Key not found in label — prefix it
	return `[${theme.fg("accent", upperKey)}] ${label}`;
}
