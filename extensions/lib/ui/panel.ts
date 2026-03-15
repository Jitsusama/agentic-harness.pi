/**
 * Panel — public entry points for the component library.
 *
 * Two interaction patterns:
 *   - prompt(): interactive decisions (single or tabbed)
 *   - view(): read-only display
 *
 * Delegates to prompt-single.ts and prompt-tabbed.ts for the
 * interactive implementations. Shared layout helpers live in
 * panel-layout.ts.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { showSinglePrompt } from "./prompt-single.js";
import { showTabbedPrompt } from "./prompt-tabbed.js";
import {
	contentBudget,
	handleScrollInput,
	maxContentWidth,
	renderScrollRegion,
	type ScrollState,
} from "./scroll-region.js";
import {
	GLYPH,
	type PromptResult,
	SCROLLBAR_GUTTER,
	type SinglePromptConfig,
	type TabbedPromptConfig,
	type TabbedResult,
	type ViewConfig,
} from "./types.js";

// Re-export layout helpers for backward compatibility
export { buildHintBar, computeChromeLines } from "./panel-layout.js";

// ---- prompt ----

/**
 * Show a single interactive prompt. Returns the user's decision
 * or null on cancel (Escape).
 */
export async function prompt(
	ctx: ExtensionContext,
	config: SinglePromptConfig,
): Promise<PromptResult | null>;

/**
 * Show a tabbed interactive prompt. Returns all decisions
 * or null on cancel (Escape).
 */
export async function prompt(
	ctx: ExtensionContext,
	config: TabbedPromptConfig,
): Promise<TabbedResult | null>;

/** Implementation of both prompt overloads. */
export async function prompt(
	ctx: ExtensionContext,
	config: SinglePromptConfig | TabbedPromptConfig,
): Promise<PromptResult | TabbedResult | null> {
	if (!ctx.hasUI) return null;

	if ("items" in config) {
		return showTabbedPrompt(ctx, config);
	}
	return showSinglePrompt(ctx, config);
}

// ---- view ----

/**
 * Show read-only content. Returns when dismissed (Escape).
 */
export async function view(
	ctx: ExtensionContext,
	config: ViewConfig,
): Promise<void> {
	if (!ctx.hasUI) return;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const scroll: ScrollState = { vOffset: 0, hOffset: 0 };
		let cachedContent: string[] | null = null;
		let cachedHScroll = false;
		let cachedWidth = -1;
		const hScrollEnabled = config.allowHScroll === true;

		if (config.signal) {
			config.signal.addEventListener("abort", () => done(undefined), {
				once: true,
			});
		}

		function getContent(width: number): string[] {
			if (cachedContent && width === cachedWidth) return cachedContent;
			cachedWidth = width;
			cachedContent = config.content(theme, width - SCROLLBAR_GUTTER);
			cachedHScroll =
				hScrollEnabled &&
				maxContentWidth(cachedContent) > width - SCROLLBAR_GUTTER;
			return cachedContent;
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			const chromeLines = 2 + (config.title ? 2 : 0) + 3;
			const budget = contentBudget(chromeLines);
			const scrollResult = handleScrollInput(
				data,
				scroll,
				budget,
				cachedContent?.length ?? 0,
				cachedHScroll,
			);
			if (scrollResult) {
				scroll.vOffset = scrollResult.vOffset;
				scroll.hOffset = scrollResult.hOffset;
				tui.requestRender();
			}
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", GLYPH.hrule.repeat(width)));

			if (config.title) {
				add(` ${theme.fg("accent", theme.bold(config.title))}`);
				add("");
			}

			const chromeLines = 2 + (config.title ? 2 : 0) + 3;
			const budget = contentBudget(chromeLines);
			const contentLines = getContent(width);
			const { lines: scrolled, needsVScroll } = renderScrollRegion(
				contentLines,
				scroll,
				budget,
				width,
				theme,
				cachedHScroll,
			);
			for (const line of scrolled) add(line);

			// Pad to budget only when scrolling (keeps height stable during scroll)
			if (needsVScroll) {
				while (lines.length < budget + (config.title ? 3 : 1)) {
					lines.push("");
				}
			}

			lines.push("");
			const hints: string[] = ["Esc close"];
			if (needsVScroll) hints.push("Shift+↑↓ scroll");
			add(theme.fg("dim", ` ${hints.join(" · ")}`));

			add(theme.fg("accent", GLYPH.hrule.repeat(width)));
			return lines;
		}

		return {
			render,
			handleInput,
			invalidate() {
				cachedContent = null;
			},
		};
	});
}
