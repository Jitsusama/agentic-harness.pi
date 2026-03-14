/**
 * Panel state — constants, layout calculations, and scroll
 * clamping for panel UI components.
 */

/**
 * Lines reserved for pi chrome (header, footer, status line,
 * input area, extension widgets). Conservative estimate to
 * avoid content overflowing past the top of the terminal.
 */
export const PI_CHROME_LINES = 8;

/**
 * Fixed lines in the panel frame: top border (1), blank before
 * options (1), blank before hints (1), hints (1), bottom
 * border (1).
 */
export const PANEL_FRAME_FIXED = 5;

/** Additional lines for tab bar when in multi-page mode. */
export const TAB_BAR_LINES = 2;

/** Horizontal scroll step in visible characters. */
export const H_SCROLL_STEP = 20;

/**
 * Available terminal height for the content area. Subtracts
 * pi chrome, panel frame, and the actual option count to avoid
 * overflow when panels have many options.
 */
export function contentBudget(hasTabBar: boolean, optionCount: number): number {
	const termRows = process.stdout.rows || 40;
	const tabBar = hasTabBar ? TAB_BAR_LINES : 0;
	const frame = PANEL_FRAME_FIXED + optionCount + tabBar;
	return Math.max(5, termRows - PI_CHROME_LINES - frame);
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
