/**
 * Panel: public entry points for the component library.
 *
 * Two interaction patterns:
 *   - prompt(): interactive decisions (single or tabbed)
 *   - view(): read-only display
 *
 * Delegates to prompt-single.ts and prompt-tabbed.ts for the
 * interactive implementations. Shared layout helpers live in
 * panel-layout.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { waitedOn } from "../internal/session/wants.ts";
import { chord, frameRule, frameTitle } from "./frame.ts";
import { mountPanel, type PanelFactory } from "./mount.ts";
import { showSinglePrompt } from "./prompt-single.ts";
import { showTabbedPrompt } from "./prompt-tabbed.ts";
import { showWorkspacePrompt } from "./prompt-workspace.ts";
import {
	contentBudget,
	HSCROLL_CONTENT_WIDTH,
	handleScrollInput,
	maxContentWidth,
	renderScrollRegion,
	SCROLLBAR_GUTTER,
	type ScrollState,
} from "./scroll-region.ts";
import type {
	PromptResult,
	SinglePromptConfig,
	TabbedPromptConfig,
	TabbedResult,
	ViewConfig,
	WorkspacePromptConfig,
	WorkspaceResult,
} from "./types.ts";

/** The line a prompt with no title is waited on with. */
const UNTITLED_WANT = "Waiting for your answer";

/**
 * Show a single interactive prompt. Returns the user's decision
 * or null on cancel (Escape). Left unanswered a while, it says the
 * session wants its person (see `lib/internal/session/wants.ts`).
 */
export async function promptSingle(
	ctx: ExtensionContext,
	config: SinglePromptConfig,
): Promise<PromptResult | null> {
	if (!ctx.hasUI) return null;
	return waitedOn(
		config.want?.kind ?? "approval",
		config.want?.said ?? config.title ?? UNTITLED_WANT,
		showSinglePrompt(ctx, config),
	);
}

/**
 * Show a tabbed interactive prompt. Returns all decisions
 * or null on cancel (Escape). Waited on as `promptSingle` is.
 */
export async function promptTabbed(
	ctx: ExtensionContext,
	config: TabbedPromptConfig,
): Promise<TabbedResult | null> {
	if (!ctx.hasUI) return null;
	return waitedOn(
		config.want?.kind ?? "approval",
		config.want?.said ?? config.title ?? UNTITLED_WANT,
		showTabbedPrompt(ctx, config),
	);
}

/**
 * Show an interactive prompt, dispatching to single or tabbed
 * based on the config shape. Prefer `promptSingle` or
 * `promptTabbed` for unambiguous types.
 *
 * @deprecated Use `promptSingle` or `promptTabbed` directly.
 */
export async function prompt(
	ctx: ExtensionContext,
	config: SinglePromptConfig,
): Promise<PromptResult | null>;
export async function prompt(
	ctx: ExtensionContext,
	config: TabbedPromptConfig,
): Promise<TabbedResult | null>;
export async function prompt(
	ctx: ExtensionContext,
	config: SinglePromptConfig | TabbedPromptConfig,
): Promise<PromptResult | TabbedResult | null> {
	if ("items" in config) {
		return promptTabbed(ctx, config as TabbedPromptConfig);
	}
	return promptSingle(ctx, config as SinglePromptConfig);
}

/**
 * Show a workspace prompt: stateful tabbed interaction where
 * tabs are workspaces with per-view actions and input handlers.
 * Returns the workspace result or null on cancel (Escape).
 */
export async function workspace(
	ctx: ExtensionContext,
	config: WorkspacePromptConfig,
): Promise<WorkspaceResult> {
	if (!ctx.hasUI) return null;
	return showWorkspacePrompt(ctx, config);
}

/**
 * Show read-only content. Returns when dismissed (Escape).
 */
export async function view(
	ctx: ExtensionContext,
	config: ViewConfig,
): Promise<void> {
	if (!ctx.hasUI) return;
	// Dismissed before its turn, it never mounts; dismissed while up, it
	// comes down by its own handle, not by hiding whatever is on top.
	await mountPanel(ctx, viewPanel(config), {
		cancelled: undefined,
		dismiss: config.signal,
	});
}

/**
 * Show read-only content while some work runs, and stop the work when a
 * person closes it. The panel comes down once the work settles, and the
 * work's answer is returned; closed first, the work's signal fires with
 * an AbortError, and so does the caller's own signal in the config.
 * Without a screen nothing is shown, and only the caller's signal stops
 * the work.
 */
export async function viewWhile<T>(
	ctx: ExtensionContext,
	config: ViewConfig,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const closed = new AbortController();
	const finished = new AbortController();
	const signal = config.signal
		? AbortSignal.any([closed.signal, config.signal])
		: closed.signal;
	const shown = ctx.hasUI
		? view(ctx, {
				...config,
				signal: config.signal
					? AbortSignal.any([finished.signal, config.signal])
					: finished.signal,
			}).then(
				() => {
					if (!finished.signal.aborted) closed.abort(panelClosed());
				},
				// A panel that could not be shown was not closed by anybody, so
				// the work carries on under its own clocks.
				() => undefined,
			)
		: Promise.resolve();
	try {
		return await work(signal);
	} finally {
		finished.abort();
		await shown;
	}
}

/** Why work shown in a panel stopped when a person closed the panel. */
function panelClosed(): DOMException {
	return new DOMException("The panel was closed.", "AbortError");
}

function viewPanel(config: ViewConfig): PanelFactory<void> {
	return (tui, theme, _kb, done) => {
		const scroll: ScrollState = { vOffset: 0, hOffset: 0 };
		let cachedContent: string[] | null = null;
		let cachedHScroll = false;
		let cachedWidth = -1;
		const hScrollEnabled = config.allowHScroll === true;

		function getContent(width: number): string[] {
			if (cachedContent && width === cachedWidth) return cachedContent;
			cachedWidth = width;
			const contentWidth = hScrollEnabled
				? HSCROLL_CONTENT_WIDTH
				: width - SCROLLBAR_GUTTER;
			cachedContent = config.content(theme, contentWidth);
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
			const maxH = Math.max(
				0,
				maxContentWidth(cachedContent ?? []) - (cachedWidth - SCROLLBAR_GUTTER),
			);
			const scrollResult = handleScrollInput(
				data,
				scroll,
				budget,
				cachedContent?.length ?? 0,
				cachedHScroll,
				maxH,
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

			add(frameRule(theme, width));

			if (config.title) {
				add(` ${frameTitle(theme, config.title)}`);
				add("");
			}

			const chromeLines = 2 + (config.title ? 2 : 0) + 3;
			const budget = contentBudget(chromeLines);
			const contentLines = getContent(width);
			const {
				lines: scrolled,
				needsVScroll,
				needsHScroll,
			} = renderScrollRegion(
				contentLines,
				scroll,
				budget,
				width,
				theme,
				cachedHScroll,
			);
			for (const line of scrolled) add(line);

			// We pad to budget only when scrolling to keep height stable.
			if (needsVScroll) {
				while (lines.length < budget + (config.title ? 3 : 1)) {
					lines.push("");
				}
			}

			lines.push("");
			const hints: string[] = [chord(theme, "Esc", "close")];
			if (needsVScroll) hints.push(chord(theme, "⇧+↑↓", "scroll"));
			if (needsHScroll) hints.push(chord(theme, "⇧+←→", "pan"));
			add(` ${hints.join(theme.fg("dim", " · "))}`);

			add(frameRule(theme, width));
			return lines;
		}

		return {
			render,
			handleInput,
			invalidate() {
				cachedContent = null;
			},
		};
	};
}
