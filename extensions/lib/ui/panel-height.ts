/**
 * Panel height mode: mutable state controlling which height
 * fraction panels use. Extensions toggle the mode via shortcuts;
 * scroll-region reads the current fraction when computing the
 * content budget.
 *
 * State lives on globalThis so it's shared across pi's per-extension
 * module boundaries.
 */

import type { PanelHeightMode } from "./types.js";

/** Panel height fraction when minimized. */
export const HEIGHT_FRACTION_MINIMIZED = 0.25;

/** Panel height fraction at normal size. */
export const HEIGHT_FRACTION_NORMAL = 0.6;

/** Panel height fraction when fullscreen. */
export const HEIGHT_FRACTION_FULLSCREEN = 0.9;

const STATE_KEY = Symbol.for("pi:panelHeightMode");

/** Get the current panel height mode. */
export function getPanelHeightMode(): PanelHeightMode {
	return (
		((globalThis as Record<symbol, unknown>)[STATE_KEY] as
			| PanelHeightMode
			| undefined) ?? "normal"
	);
}

/** Set the panel height mode. */
export function setPanelHeightMode(next: PanelHeightMode): void {
	(globalThis as Record<symbol, unknown>)[STATE_KEY] = next;
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
