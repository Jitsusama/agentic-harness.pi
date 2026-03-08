/**
 * Panel — shared UI primitive for bordered, scrollable content
 * with options and an inline editor.
 *
 * Two public APIs:
 *   showPanel       — single-shot: one page, returns on selection
 *   showPanelSeries — multi-page with tabs, returns when complete
 *
 * Both share the same rendering internals: scrollable content
 * viewport with scrollbar, numbered options with descriptions,
 * inline editor triggered by designated options, and accent
 * border chrome.
 */

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import {
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";

// ---- Types ----

export interface PanelOption {
	label: string;
	value: string;
	/** Optional description shown below the label. */
	description?: string;
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

// ---- Constants ----

/**
 * Lines reserved for pi chrome (header, footer, status line,
 * input area). Conservative estimate to avoid overflow.
 */
const PI_CHROME_LINES = 6;

/**
 * Lines used by the panel's own frame: top border, bottom
 * border, options, hint line, and spacing.
 */
const PANEL_FRAME_LINES = 7;

/** Additional lines for tab bar when in multi-page mode. */
const TAB_BAR_LINES = 2;

// ---- Shared internals ----

export function buildEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function renderOptionsList(
	options: PanelOption[],
	selected: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	for (let i = 0; i < options.length; i++) {
		const opt = options[i]!;
		const active = i === selected;
		const prefix = active ? theme.fg("accent", "> ") : "  ";
		const color = active ? "accent" : "text";
		lines.push(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
		if (opt.description) {
			lines.push(`     ${theme.fg("muted", opt.description)}`);
		}
	}
	return lines;
}

function renderInlineEditor(
	editor: Editor,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [""];
	for (const line of editor.render(width - 4)) {
		lines.push(` ┃ ${line}`);
	}
	lines.push("");
	lines.push(theme.fg("dim", " Enter submit · Esc back"));
	return lines;
}

/** Available terminal height for the content area. */
function contentBudget(hasTabBar: boolean): number {
	const termRows = process.stdout.rows || 40;
	const extra = hasTabBar ? TAB_BAR_LINES : 0;
	return Math.max(5, termRows - PI_CHROME_LINES - PANEL_FRAME_LINES - extra);
}

/**
 * Build a scrollbar column for the viewport. Returns one
 * character per visible line: █ for the thumb, ░ for the track.
 */
function buildScrollbar(
	totalLines: number,
	viewportSize: number,
	offset: number,
	theme: Theme,
): string[] {
	const thumbSize = Math.max(1, Math.round(
		(viewportSize / totalLines) * viewportSize,
	));
	const maxOffset = totalLines - viewportSize;
	const scrollFraction = maxOffset > 0 ? offset / maxOffset : 0;
	const thumbStart = Math.round(
		scrollFraction * (viewportSize - thumbSize),
	);

	const bar: string[] = [];
	for (let i = 0; i < viewportSize; i++) {
		const isThumb = i >= thumbStart && i < thumbStart + thumbSize;
		bar.push(
			isThumb
				? theme.fg("accent", "█")
				: theme.fg("dim", "░"),
		);
	}
	return bar;
}

/** Render scrollable content with optional scrollbar. */
function renderScrollableContent(
	contentLines: string[],
	scrollOffset: number,
	hScrollOffset: number,
	budget: number,
	width: number,
	theme: Theme,
): { lines: string[]; needsVScroll: boolean; needsHScroll: boolean } {
	const needsVScroll = contentLines.length > budget;
	const needsHScroll = maxContentWidth(contentLines) > width;
	const lines: string[] = [];

	if (needsVScroll) {
		const visible = contentLines.slice(
			scrollOffset,
			scrollOffset + budget,
		);
		const scrollbar = buildScrollbar(
			contentLines.length,
			budget,
			scrollOffset,
			theme,
		);
		const contentWidth = width - 2;
		for (let i = 0; i < visible.length; i++) {
			const sliced = truncateToWidth(
				horizontalSlice(visible[i]!, hScrollOffset, contentWidth),
				contentWidth,
			);
			// CSI absolute column positioning for the scrollbar.
			// Move cursor to the last column and draw the scrollbar char.
			const scrollCol = width;
			lines.push(
				sliced + `\x1b[${scrollCol}G` + scrollbar[i]!,
			);
		}
	} else {
		for (const line of contentLines) {
			lines.push(truncateToWidth(
				horizontalSlice(line, hScrollOffset, width),
				width,
			));
		}
	}

	return { lines, needsVScroll, needsHScroll };
}

function renderTabBar(
	pages: PanelPage[],
	currentTab: number,
	selections: Map<number, SeriesSelection>,
	theme: Theme,
): string {
	const tabs: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		const isActive = i === currentTab;
		const isAnswered = selections.has(i);
		const lbl = pages[i]!.label;
		const box = isAnswered ? "■" : "□";
		const color = isAnswered ? "success" : "muted";
		const text = ` ${box} ${lbl} `;
		const styled = isActive
			? theme.bg("selectedBg", theme.fg("text", text))
			: theme.fg(color, text);
		tabs.push(`${styled} `);
	}
	return ` ${tabs.join("")}`;
}

function clampScroll(
	scrollOffset: number,
	contentLength: number,
	budget: number,
): number {
	const maxScroll = Math.max(0, contentLength - budget);
	return Math.max(0, Math.min(scrollOffset, maxScroll));
}

/**
 * ANSI-aware horizontal slice. Skips `offset` visible characters
 * from the start, then takes up to `width` visible characters.
 * Preserves ANSI escape sequences that are active at the slice
 * boundary.
 */
function horizontalSlice(
	text: string,
	offset: number,
	width: number,
): string {
	if (offset === 0) return truncateToWidth(text, width);

	// Walk through the string tracking visible character count
	let visCount = 0;
	let i = 0;
	let activeEscapes = ""; // accumulate active ANSI sequences

	// Phase 1: skip `offset` visible characters, collecting ANSI state
	while (i < text.length && visCount < offset) {
		if (text[i] === "\x1b" && text[i + 1] === "[") {
			// ANSI escape sequence — consume it
			const escStart = i;
			i += 2;
			while (i < text.length && !/[A-Za-z]/.test(text[i]!)) i++;
			i++; // consume the terminator
			const esc = text.slice(escStart, i);
			// Track resets vs active sequences
			if (esc === "\x1b[0m" || esc === "\x1b[m") {
				activeEscapes = "";
			} else {
				activeEscapes += esc;
			}
		} else {
			visCount++;
			i++;
		}
	}

	// Phase 2: extract the visible portion from offset
	const remainder = activeEscapes + text.slice(i);
	return truncateToWidth(remainder, width);
}

/** Find the maximum visible width across content lines. */
function maxContentWidth(lines: string[]): number {
	let max = 0;
	for (const line of lines) {
		const w = visibleWidth(line);
		if (w > max) max = w;
	}
	return max;
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
		const H_SCROLL_STEP = 20;
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

			// Vertical scroll
			const budget = contentBudget(false);
			if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) {
				scrollOffset = Math.max(0, scrollOffset - budget);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) {
				scrollOffset += budget;
				tui.requestRender();
				return;
			}

			// Horizontal scroll
			if (matchesKey(data, "shift+left")) {
				hScrollOffset = Math.max(0, hScrollOffset - H_SCROLL_STEP);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "shift+right")) {
				hScrollOffset += H_SCROLL_STEP;
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.up)) {
				selected = Math.max(0, selected - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selected = Math.min(page.options.length - 1, selected + 1);
				tui.requestRender();
				return;
			}

			// Number keys
			const num = parseInt(data, 10);
			if (num >= 1 && num <= page.options.length) {
				selected = num - 1;
			} else if (!matchesKey(data, Key.enter)) {
				return;
			}

			// Confirm selection
			const opt = page.options[selected]!;
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

			const { lines: scrolled, needsVScroll, needsHScroll } =
				renderScrollableContent(
					contentLines, scrollOffset, hScrollOffset,
					budget, width, theme,
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
			const H_SCROLL_STEP = 20;
			let currentTab = 0;
			let optionIndex = 0;
			let editorMode = false;
			let editorOptionValue = "";
			let scrollOffset = 0;
			let hScrollOffset = 0;
			let busy = false; // true while awaiting async onSelect
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

			async function handleSelection(
				value: string,
				editorText?: string,
			) {
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
					// Single page, no onSelect — resolve immediately
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
				if (busy) return; // ignore input during async onSelect

				const page = pages[currentTab]!;

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
					if (
						matchesKey(data, Key.tab) ||
						matchesKey(data, Key.right)
					) {
						currentTab = (currentTab + 1) % pages.length;
						optionIndex = 0;
						scrollOffset = 0;
						hScrollOffset = 0;
						tui.requestRender();
						return;
					}
					if (
						matchesKey(data, Key.shift("tab")) ||
						matchesKey(data, Key.left)
					) {
						currentTab =
							(currentTab - 1 + pages.length) % pages.length;
						optionIndex = 0;
						scrollOffset = 0;
						hScrollOffset = 0;
						tui.requestRender();
						return;
					}
				}

				// Vertical scroll
				const budget = contentBudget(isMulti);
				if (
					matchesKey(data, "pageup") ||
					matchesKey(data, "shift+up")
				) {
					scrollOffset = Math.max(0, scrollOffset - budget);
					tui.requestRender();
					return;
				}
				if (
					matchesKey(data, "pagedown") ||
					matchesKey(data, "shift+down")
				) {
					scrollOffset += budget;
					tui.requestRender();
					return;
				}

				// Horizontal scroll
				if (matchesKey(data, "shift+left")) {
					hScrollOffset = Math.max(0, hScrollOffset - H_SCROLL_STEP);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "shift+right")) {
					hScrollOffset += H_SCROLL_STEP;
					tui.requestRender();
					return;
				}

				// Option navigation
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(
						page.options.length - 1,
						optionIndex + 1,
					);
					tui.requestRender();
					return;
				}

				// Number keys
				const num = parseInt(data, 10);
				if (num >= 1 && num <= page.options.length) {
					optionIndex = num - 1;
				} else if (!matchesKey(data, Key.enter)) {
					return;
				}

				// Confirm selection
				const opt = page.options[optionIndex]!;
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
				const add = (s: string) =>
					lines.push(truncateToWidth(s, width));

				add(theme.fg("accent", "─".repeat(width)));

				// Tab bar
				if (isMulti) {
					add(renderTabBar(pages, currentTab, selections, theme));
					lines.push("");
				}

				// Content
				const page = pages[currentTab]!;
				const budget = contentBudget(isMulti);
				const contentLines = page.content(theme, width + hScrollOffset);
				scrollOffset = clampScroll(
					scrollOffset,
					contentLines.length,
					budget,
				);

				const { lines: scrolled, needsVScroll, needsHScroll } =
					renderScrollableContent(
						contentLines,
						scrollOffset,
						hScrollOffset,
						budget,
						width,
						theme,
					);
				for (const line of scrolled) add(line);

				if (editorMode) {
					for (const line of renderInlineEditor(
						editor,
						width,
						theme,
					)) {
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
