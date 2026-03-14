/**
 * Status utilities — mode indicators and detail widgets for
 * the footer and above-editor areas.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Set a mode status indicator in the footer.
 * The glyph is displayed with the label as a status segment.
 */
export function setModeStatus(
	ctx: ExtensionContext,
	key: string,
	glyph: string,
	label: string,
): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(key, `${glyph} ${label}`);
}

/**
 * Set a right-aligned detail widget above the editor.
 * Used for mode context (e.g., TDD phase, PR reply progress).
 */
export function setDetailWidget(
	ctx: ExtensionContext,
	key: string,
	label: string,
): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(key, [label]);
}

/** Clear a mode status or detail widget. */
export function clearStatus(ctx: ExtensionContext, key: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(key, undefined);
	ctx.ui.setWidget(key, undefined);
}
