/**
 * Panel — shared UI primitive for bordered, scrollable content
 * with options and inline editor.
 *
 * Two public APIs:
 *   showPanel       — single-shot: one page, returns on selection
 *   showPanelSeries — multi-page with tabs, returns when complete
 *
 * Both compose the same building blocks from panel-state,
 * panel-render, and panel-keys.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	Key,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import {
	handleOptionNav,
	handleScrollKeys,
	handleTabNav,
	resolveConfirmation,
} from "./panel-keys.js";
import {
	buildEditorTheme,
	renderInlineEditor,
	renderOptionsList,
	renderScrollableContent,
	renderTabBar,
} from "./panel-render.js";
import { clampScroll, contentBudget } from "./panel-state.js";

// ---- Types ----

export interface PanelOption {
	label: string;
	value: string;
	/** Optional description shown below the label. */
	description?: string;
	/** Icon shown in the tab bar when this option is selected (defaults to ✓). */
	icon?: string;
	/** When true, selecting this option opens an inline editor. */
	opensEditor?: boolean;
	/** Pre-fill text for the inline editor. */
	editorPreFill?: string;
}

export interface PanelPage {
	/** Tab label (shown in tab bar for multi-page panels). */
	label: string;
	/** Renders the content section. */
	content: (theme: Theme, width: number) => string[];
	/** Selectable options. */
	options: PanelOption[];
}

export interface PanelResult {
	/** The selected option's value. */
	value: string;
	/** Present when an opensEditor option was selected and submitted. */
	editorText?: string;
}

export interface SeriesSelection {
	pageIndex: number;
	value: string;
	editorText?: string;
}

export interface PanelSeriesConfig {
	pages: PanelPage[];
	/**
	 * Called on each selection. Return true to resolve the
	 * series. Async — can open ctx.ui.editor() as an overlay
	 * for full-screen editing while the panel stays underneath.
	 * The panel pauses input handling until onSelect completes.
	 */
	onSelect?: (
		selection: SeriesSelection,
		all: Map<number, SeriesSelection>,
	) => Promise<boolean> | boolean;
}

// ---- showPanel (single-shot) ----

/**
 * Show a single-page panel. Returns the selected option or
 * null on cancel (Escape).
 */
export async function showPanel(
	ctx: ExtensionContext,
	config: { page: PanelPage },
): Promise<PanelResult | null> {
	if (!ctx.hasUI) return null;

	const { page } = config;
	return ctx.ui.custom<PanelResult | null>((tui, theme, _kb, done) => {
		let selected = 0;
		let editorMode = false;
		let editorOptionValue = "";
		let scrollOffset = 0;
		let hScrollOffset = 0;
		const editor = new Editor(tui, buildEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				editorMode = false;
				editor.setText("");
				tui.requestRender();
				return;
			}
			done({ value: editorOptionValue, editorText: trimmed });
		};

		function handleInput(data: string) {
			if (editorMode) {
				if (matchesKey(data, Key.escape)) {
					editorMode = false;
					editor.setText("");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			const budget = contentBudget(false);
			const scroll = handleScrollKeys(
				data,
				scrollOffset,
				hScrollOffset,
				budget,
			);
			if (scroll) {
				scrollOffset = scroll.vOffset;
				hScrollOffset = scroll.hOffset;
				tui.requestRender();
				return;
			}

			const nav = handleOptionNav(data, selected, page.options.length);
			if (nav !== null) {
				selected = nav;
				tui.requestRender();
				return;
			}

			const confirmed = resolveConfirmation(
				data,
				selected,
				page.options.length,
			);
			if (confirmed === null) return;

			selected = confirmed;
			const opt = page.options[selected];
			if (!opt) return;
			if (opt.opensEditor) {
				editorMode = true;
				editorOptionValue = opt.value;
				editor.setText(opt.editorPreFill ?? "");
				tui.requestRender();
			} else {
				done({ value: opt.value });
			}
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));

			const budget = contentBudget(false);
			const contentLines = page.content(theme, width + hScrollOffset);
			scrollOffset = clampScroll(scrollOffset, contentLines.length, budget);

			const {
				lines: scrolled,
				needsVScroll,
				needsHScroll,
			} = renderScrollableContent(
				contentLines,
				scrollOffset,
				hScrollOffset,
				budget,
				width,
				theme,
			);
			for (const line of scrolled) add(line);

			if (editorMode) {
				for (const line of renderInlineEditor(editor, width, theme)) {
					add(line);
				}
			} else {
				lines.push("");
				for (const line of renderOptionsList(page.options, selected, theme)) {
					add(line);
				}
				lines.push("");
				const hints: string[] = ["↑↓ select", "Enter confirm", "Esc cancel"];
				if (needsVScroll) hints.push("Shift+↑↓ scroll");
				if (needsHScroll) hints.push("Shift+←→ pan");
				add(theme.fg("dim", ` ${hints.join(" · ")}`));
			}

			add(theme.fg("accent", "─".repeat(width)));
			return lines;
		}

		return { render, handleInput };
	});
}

// ---- showPanelSeries (multi-page) ----

/**
 * Show a multi-page panel with tab navigation. Returns all
 * accumulated selections or null on cancel (Escape).
 *
 * For single-page usage, the tab bar is hidden and the panel
 * behaves like showPanel but routes through onSelect.
 */
export async function showPanelSeries(
	ctx: ExtensionContext,
	config: PanelSeriesConfig,
): Promise<Map<number, SeriesSelection> | null> {
	if (!ctx.hasUI) return null;

	const { pages, onSelect } = config;
	const isMulti = pages.length > 1;

	return ctx.ui.custom<Map<number, SeriesSelection> | null>(
		(tui, theme, _kb, done) => {
			let currentTab = 0;
			let optionIndex = 0;
			let editorMode = false;
			let editorOptionValue = "";
			let scrollOffset = 0;
			let hScrollOffset = 0;
			let busy = false;
			const selections = new Map<number, SeriesSelection>();
			const editor = new Editor(tui, buildEditorTheme(theme));

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (!trimmed) {
					editorMode = false;
					editor.setText("");
					tui.requestRender();
					return;
				}
				handleSelection(editorOptionValue, trimmed);
			};

			async function handleSelection(value: string, editorText?: string) {
				const selection: SeriesSelection = {
					pageIndex: currentTab,
					value,
					editorText,
				};

				selections.set(currentTab, selection);

				if (onSelect) {
					busy = true;
					tui.requestRender();
					try {
						const resolve = await onSelect(selection, selections);
						if (resolve) {
							done(selections);
							return;
						}
					} finally {
						busy = false;
					}
				} else if (!isMulti) {
					done(selections);
					return;
				}

				// Advance to next unanswered page
				editorMode = false;
				editor.setText("");
				if (isMulti) {
					for (let i = 1; i <= pages.length; i++) {
						const next = (currentTab + i) % pages.length;
						if (!selections.has(next)) {
							currentTab = next;
							optionIndex = 0;
							scrollOffset = 0;
							tui.requestRender();
							return;
						}
					}
				}

				optionIndex = 0;
				scrollOffset = 0;
				tui.requestRender();
			}

			function handleInput(data: string) {
				if (busy) return;

				const page = pages[currentTab];
				if (!page) return;

				if (editorMode) {
					if (matchesKey(data, Key.escape)) {
						editorMode = false;
						editor.setText("");
						tui.requestRender();
						return;
					}
					editor.handleInput(data);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}

				// Tab navigation (multi-page only)
				if (isMulti) {
					const tab = handleTabNav(data, currentTab, pages.length);
					if (tab !== null) {
						currentTab = tab;
						optionIndex = 0;
						scrollOffset = 0;
						hScrollOffset = 0;
						tui.requestRender();
						return;
					}
				}

				const budget = contentBudget(isMulti);
				const scroll = handleScrollKeys(
					data,
					scrollOffset,
					hScrollOffset,
					budget,
				);
				if (scroll) {
					scrollOffset = scroll.vOffset;
					hScrollOffset = scroll.hOffset;
					tui.requestRender();
					return;
				}

				const nav = handleOptionNav(data, optionIndex, page.options.length);
				if (nav !== null) {
					optionIndex = nav;
					tui.requestRender();
					return;
				}

				const confirmed = resolveConfirmation(
					data,
					optionIndex,
					page.options.length,
				);
				if (confirmed === null) return;

				optionIndex = confirmed;
				const opt = page.options[optionIndex];
				if (!opt) return;
				if (opt.opensEditor) {
					editorMode = true;
					editorOptionValue = opt.value;
					editor.setText(opt.editorPreFill ?? "");
					tui.requestRender();
				} else {
					handleSelection(opt.value);
				}
			}

			function render(width: number): string[] {
				const lines: string[] = [];
				const add = (s: string) => lines.push(truncateToWidth(s, width));

				add(theme.fg("accent", "─".repeat(width)));

				if (isMulti) {
					add(renderTabBar(pages, currentTab, selections, theme));
					lines.push("");
				}

				const page = pages[currentTab];
				if (!page) return lines;
				const budget = contentBudget(isMulti);
				const contentLines = page.content(theme, width + hScrollOffset);
				scrollOffset = clampScroll(scrollOffset, contentLines.length, budget);

				const {
					lines: scrolled,
					needsVScroll,
					needsHScroll,
				} = renderScrollableContent(
					contentLines,
					scrollOffset,
					hScrollOffset,
					budget,
					width,
					theme,
				);
				for (const line of scrolled) add(line);

				if (editorMode) {
					for (const line of renderInlineEditor(editor, width, theme)) {
						add(line);
					}
				} else {
					lines.push("");
					for (const line of renderOptionsList(
						page.options,
						optionIndex,
						theme,
					)) {
						add(line);
					}
					lines.push("");
					const hints: string[] = [];
					if (isMulti) hints.push("Tab/←→ navigate");
					hints.push("↑↓ select");
					hints.push("Enter confirm");
					hints.push("Esc cancel");
					if (needsVScroll) hints.push("Shift+↑↓ scroll");
					if (needsHScroll) hints.push("Shift+←→ pan");
					add(theme.fg("dim", ` ${hints.join(" · ")}`));
				}

				add(theme.fg("accent", "─".repeat(width)));
				return lines;
			}

			return { render, handleInput };
		},
	);
}
