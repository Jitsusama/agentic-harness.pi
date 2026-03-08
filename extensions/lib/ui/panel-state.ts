/**
 * Panel state — constants, layout calculations, and scroll
 * clamping for panel UI components.
 */

/**
 * Lines reserved for pi chrome (header, footer, status line,
 * input area). Conservative estimate to avoid overflow.
 */
export const PI_CHROME_LINES = 6;

/**
 * Lines used by the panel's own frame: top border, bottom
 * border, options, hint line, and spacing.
 */
export const PANEL_FRAME_LINES = 7;

/** Additional lines for tab bar when in multi-page mode. */
export const TAB_BAR_LINES = 2;

/** Horizontal scroll step in visible characters. */
export const H_SCROLL_STEP = 20;

/** Available terminal height for the content area. */
export function contentBudget(hasTabBar: boolean): number {
	const termRows = process.stdout.rows || 40;
	const extra = hasTabBar ? TAB_BAR_LINES : 0;
	return Math.max(5, termRows - PI_CHROME_LINES - PANEL_FRAME_LINES - extra);
}

/** Clamp a scroll offset to valid bounds. */
export function clampScroll(
	scrollOffset: number,
	contentLength: number,
	budget: number,
): number {
	const maxScroll = Math.max(0, contentLength - budget);
	return Math.max(0, Math.min(scrollOffset, maxScroll));
}
