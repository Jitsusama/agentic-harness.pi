/**
 * ActionBar — key-hint action bar with Shift+key steer annotations.
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
): string {
	const parts: string[] = [];

	for (const action of actions) {
		parts.push(formatActionLabel(action, theme));
	}

	const left = ` ${parts.join("  ")}`;
	const hint = theme.fg("dim", "⇧+key to annotate");

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

	// Plain letter = immediate action
	for (const action of actions) {
		if (matchesKey(data, action.key)) {
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

	// Key not found in label — prefix it
	return `[${theme.fg("accent", upperKey)}] ${label}`;
}
