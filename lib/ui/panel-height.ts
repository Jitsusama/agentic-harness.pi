/**
 * Panel height mode: mutable state controlling which height
 * fraction panels use. Extensions toggle the mode via shortcuts;
 * scroll-region reads the current fraction when computing the
 * content budget.
 *
 * State lives on the screen's key (`screen-slot.ts`) so it's shared
 * across pi's per-extension module boundaries, and so one hosted
 * conversation's zoom sizes only its own screen.
 */

import { keepOnScreen, screenValue } from "./screen-slot.ts";
import type { PanelHeightMode } from "./types.ts";

/** Panel height fraction when minimized. */
const HEIGHT_FRACTION_MINIMIZED = 0.25;

/** Panel height fraction at normal size. */
const HEIGHT_FRACTION_NORMAL = 0.6;

/** Panel height fraction when fullscreen. */
const HEIGHT_FRACTION_FULLSCREEN = 0.9;

/** The name every copy looks for. The string is the contract; keep it. */
const STATE_NAME = "pi:panelHeightMode";

function isMode(value: unknown): value is PanelHeightMode {
	return value === "minimized" || value === "normal" || value === "fullscreen";
}

/** Get the current panel height mode. */
export function getPanelHeightMode(): PanelHeightMode {
	const mode = screenValue(STATE_NAME);
	return isMode(mode) ? mode : "normal";
}

/** Set the panel height mode. */
export function setPanelHeightMode(next: PanelHeightMode): void {
	keepOnScreen(STATE_NAME, next);
}

/** Get the height fraction for the current mode. */
export function getPanelHeightFraction(): number {
	switch (getPanelHeightMode()) {
		case "minimized":
			return HEIGHT_FRACTION_MINIMIZED;
		case "fullscreen":
			return HEIGHT_FRACTION_FULLSCREEN;
		default:
			return HEIGHT_FRACTION_NORMAL;
	}
}

/** Glyph per mode: geometric indicators for the status bar. */
const MODE_GLYPH: Record<PanelHeightMode, string> = {
	minimized: "━",
	normal: "□",
	fullscreen: "■",
};

/** Get the status glyph for the current panel height mode. */
export function getPanelHeightGlyph(): string {
	return MODE_GLYPH[getPanelHeightMode()];
}
