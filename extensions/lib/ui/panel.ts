/**
 * Panel — layout orchestrator that composes ActionBar, OptionList,
 * ScrollRegion, TabStrip, and NoteEditor into a bordered,
 * scrollable interactive panel.
 *
 * This is the root component passed to ctx.ui.custom(). It manages:
 *   - Height budget (60% max, grow-to-fit)
 *   - Keyboard routing (scroll ↔ actions/options ↔ editor)
 *   - Universal keys (Escape, Ctrl+Enter)
 *   - Steer state (Shift+key detection, NoteEditor activation)
 *   - Tab state (current tab, per-item results)
 *
 * Layout structure:
 *   DynamicBorder     ──── top accent rule
 *   TabStrip          ──── optional: when items > 1
 *   separator         ──── optional: when tabs shown
 *   ScrollRegion      ──── content viewport with scroll
 *   ActionBar         ──── when actions provided
 *     OR OptionList   ──── when options provided
 *   NoteEditor        ──── shown on demand (steer/editor)
 *   hints             ──── dim keyboard hints
 *   DynamicBorder     ──── bottom accent rule
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	isKeyRelease,
	Key,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import {
	type ActionBarResult,
	handleActionInput,
	renderActionBar,
} from "./action-bar.js";
import { buildNoteEditorTheme, renderNoteEditor } from "./note-editor.js";
import {
	handleOptionInput,
	optionValue,
	renderOptionList,
} from "./option-list.js";
import {
	contentBudget,
	handleScrollInput,
	maxContentWidth,
	renderScrollRegion,
	type ScrollState,
} from "./scroll-region.js";
import { handleTabInput, renderTabStrip } from "./tab-strip.js";
import {
	type Action,
	GLYPH,
	type Option,
	type PromptResult,
	SCROLLBAR_GUTTER,
	type SinglePromptConfig,
	type TabbedPromptConfig,
	type TabbedResult,
	type TabStatus,
	type ViewConfig,
} from "./types.js";

// ---- prompt (single) ----

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

		function getContent(width: number): string[] {
			if (cachedContent && width === cachedWidth) return cachedContent;
			cachedWidth = width;
			cachedContent = config.content(theme, width - SCROLLBAR_GUTTER);
			cachedHScroll = maxContentWidth(cachedContent) > width - SCROLLBAR_GUTTER;
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

// ---- Internal: Single prompt ----

async function showSinglePrompt(
	ctx: ExtensionContext,
	config: SinglePromptConfig,
): Promise<PromptResult | null> {
	return ctx.ui.custom<PromptResult | null>((tui, theme, _kb, done) => {
		const scroll: ScrollState = { vOffset: 0, hOffset: 0 };
		let optionIndex = 0;
		let editorMode = false;
		let cachedContent: string[] | null = null;
		let cachedHScroll = false;
		let cachedWidth = -1;
		let editorContext: {
			type: "steerAction" | "pureSteer" | "editor";
			actionKey?: string;
			label?: string;
		} | null = null;
		const editor = new Editor(tui, buildNoteEditorTheme(theme));

		const actions = config.actions;
		const options = config.options;

		editor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) {
				// Empty submit cancels editor
				editorMode = false;
				editorContext = null;
				editor.setText("");
				tui.requestRender();
				return;
			}

			if (!editorContext) return;

			if (editorContext.type === "pureSteer") {
				done({ type: "steer", note: trimmed });
			} else if (editorContext.type === "steerAction") {
				done({
					type: "action",
					value: editorContext.actionKey ?? "",
					note: trimmed,
				});
			} else if (editorContext.type === "editor") {
				done({
					type: "action",
					value: editorContext.actionKey ?? "",
					editorText: trimmed,
				});
			}
		};

		function openEditor(context: typeof editorContext, preFill?: string) {
			editorMode = true;
			editorContext = context;
			editor.setText(preFill ?? "");
			tui.requestRender();
		}

		function handleInput(data: string) {
			// Drop release events — they duplicate press events under
			// Kitty protocol flag 2 and would leak characters into
			// the NoteEditor or double-fire actions.
			if (isKeyRelease(data)) return;

			// Editor mode
			if (editorMode) {
				if (matchesKey(data, Key.escape)) {
					editorMode = false;
					editorContext = null;
					editor.setText("");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
				return;
			}

			// Universal: Escape cancels
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			// Scroll handling
			const chromeLines = computeChromeLines(false, actions, options);
			const budget = contentBudget(chromeLines);
			const scrollResult = handleScrollInput(
				data,
				scroll,
				budget,
				cachedContent?.length ?? 0,
			);
			if (scrollResult) {
				scroll.vOffset = scrollResult.vOffset;
				scroll.hOffset = scrollResult.hOffset;
				tui.requestRender();
				return;
			}

			// Action bar handling
			if (actions) {
				const result = handleActionInput(data, actions);
				if (result) {
					handleActionResult(result);
					return;
				}
			}

			// Option list handling
			if (options) {
				const result = handleOptionInput(data, optionIndex, options.length);
				if (result) {
					if (result.type === "navigate") {
						optionIndex = result.index;
						tui.requestRender();
					} else if (result.type === "select") {
						const opt = options[result.index];
						if (opt?.opensEditor) {
							openEditor(
								{ type: "editor", actionKey: optionValue(opt) },
								opt.editorPreFill,
							);
						} else if (opt) {
							done({ type: "action", value: optionValue(opt) });
						}
					} else if (result.type === "cancel") {
						done(null);
					}
					return;
				}

				// Shift+Enter on options = confirm + note
				if (matchesKey(data, Key.shift("enter")) && options.length > 0) {
					const opt = options[optionIndex];
					if (opt) {
						openEditor({
							type: "steerAction",
							actionKey: optionValue(opt),
						});
					}
					return;
				}
			}
		}

		function handleActionResult(result: ActionBarResult) {
			if (result.type === "action") {
				done({ type: "action", value: result.key });
			} else if (result.type === "steerAction") {
				const action = actions?.find((a) => a.key === result.key);
				openEditor({
					type: "steerAction",
					actionKey: result.key,
					label: action?.label,
				});
			} else if (result.type === "pureSteer") {
				openEditor({ type: "pureSteer" });
			}
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			// Top border
			add(theme.fg("accent", GLYPH.hrule.repeat(width)));

			// Content (cached — only re-render on width change)
			const chromeLines = computeChromeLines(false, actions, options);
			const budget = contentBudget(chromeLines);
			if (!cachedContent || width !== cachedWidth) {
				cachedContent = config.content(theme, width - SCROLLBAR_GUTTER);
				cachedHScroll =
					maxContentWidth(cachedContent) > width - SCROLLBAR_GUTTER;
				cachedWidth = width;
			}
			const contentLines = cachedContent;
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

			// Pad to budget only when scrolling (keeps height stable during scroll)
			if (needsVScroll) {
				while (lines.length < budget + 1) {
					lines.push("");
				}
			}

			if (editorMode) {
				// NoteEditor
				const editorLabel = editorContext?.label
					? `${editorContext.label} with note:`
					: editorContext?.type === "pureSteer"
						? "Feedback:"
						: "Note:";
				for (const line of renderNoteEditor(editor, width, theme, {
					label: editorLabel,
				})) {
					add(line);
				}
			} else {
				// Action bar and/or option list
				if (actions) {
					lines.push("");
					add(renderActionBar(actions, width, theme));
				}
				if (options) {
					lines.push("");
					for (const line of renderOptionList(options, optionIndex, theme)) {
						add(line);
					}
				}

				// Hint bar
				lines.push("");
				const hints = buildHints(false, needsVScroll, needsHScroll, !!actions);
				add(theme.fg("dim", ` ${hints.join(" · ")}`));
			}

			// Bottom border
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

// ---- Internal: Tabbed prompt ----

async function showTabbedPrompt(
	ctx: ExtensionContext,
	config: TabbedPromptConfig,
): Promise<TabbedResult | null> {
	return ctx.ui.custom<TabbedResult | null>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let editorMode = false;
		const contentCache = new Map<
			number,
			{ lines: string[]; width: number; hScroll: boolean }
		>();
		let editorContext: {
			type: "steerAction" | "pureSteer" | "editor" | "addItem";
			actionKey?: string;
			label?: string;
		} | null = null;

		const scrollStates: ScrollState[] = config.items.map(() => ({
			vOffset: 0,
			hOffset: 0,
		}));
		const results = new Map<number, PromptResult>();
		const userItems: string[] = [];
		const editor = new Editor(tui, buildNoteEditorTheme(theme));

		editor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) {
				editorMode = false;
				editorContext = null;
				editor.setText("");
				tui.requestRender();
				return;
			}

			if (!editorContext) return;

			if (editorContext.type === "addItem") {
				userItems.push(trimmed);
				editorMode = false;
				editorContext = null;
				editor.setText("");
				tui.requestRender();
				return;
			}

			let result: PromptResult;
			if (editorContext.type === "pureSteer") {
				result = { type: "steer", note: trimmed };
			} else if (editorContext.type === "steerAction") {
				result = {
					type: "action",
					value: editorContext.actionKey ?? "",
					note: trimmed,
				};
			} else {
				result = {
					type: "action",
					value: editorContext.actionKey ?? "",
					editorText: trimmed,
				};
			}

			results.set(currentTab, result);
			editorMode = false;
			editorContext = null;
			editor.setText("");

			if (config.autoResolve && results.size === config.items.length) {
				done({ items: results, userItems });
				return;
			}

			advanceToNext();
			tui.requestRender();
		};

		function advanceToNext() {
			for (let i = 1; i <= config.items.length; i++) {
				const next = (currentTab + i) % config.items.length;
				if (!results.has(next)) {
					currentTab = next;
					optionIndex = 0;
					return;
				}
			}
		}

		function currentActions(): Action[] | undefined {
			return config.items[currentTab]?.actions ?? config.actions;
		}

		function currentOptions(): Option[] | undefined {
			return config.items[currentTab]?.options ?? config.options;
		}

		function handleInput(data: string) {
			// Drop release events (see single prompt comment)
			if (isKeyRelease(data)) return;

			if (editorMode) {
				if (matchesKey(data, Key.escape)) {
					editorMode = false;
					editorContext = null;
					editor.setText("");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
				return;
			}

			// Universal: Escape cancels everything
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			// Ctrl+Enter submits
			if (matchesKey(data, Key.ctrl("enter"))) {
				done({ items: results, userItems });
				return;
			}

			// '+' adds item
			if (config.canAddItems && data === "+") {
				openEditor({ type: "addItem" });
				return;
			}

			// Tab navigation
			const tabResult = handleTabInput(data, currentTab, config.items.length);
			if (tabResult !== null) {
				currentTab = tabResult;
				optionIndex = 0;
				tui.requestRender();
				return;
			}

			// Scroll
			const actions = currentActions();
			const options = currentOptions();
			const chromeLines = computeChromeLines(true, actions, options);
			const budget = contentBudget(chromeLines);
			const scrollState = scrollStates[currentTab] ?? {
				vOffset: 0,
				hOffset: 0,
			};
			const cachedEntry = contentCache.get(currentTab);
			const scrollResult = handleScrollInput(
				data,
				scrollState,
				budget,
				cachedEntry?.lines.length ?? 0,
			);
			if (scrollResult) {
				scrollStates[currentTab] = scrollResult;
				tui.requestRender();
				return;
			}

			// Action bar
			if (actions) {
				const result = handleActionInput(data, actions);
				if (result) {
					handleActionResult(result);
					return;
				}
			}

			// Option list
			if (options) {
				const result = handleOptionInput(data, optionIndex, options.length);
				if (result) {
					if (result.type === "navigate") {
						optionIndex = result.index;
						tui.requestRender();
					} else if (result.type === "select") {
						const opt = options[result.index];
						if (opt?.opensEditor) {
							openEditor(
								{ type: "editor", actionKey: optionValue(opt) },
								opt.editorPreFill,
							);
						} else if (opt) {
							handleItemResult({
								type: "action",
								value: optionValue(opt),
							});
						}
					}
					return;
				}

				if (matchesKey(data, Key.shift("enter")) && options.length > 0) {
					const opt = options[optionIndex];
					if (opt) {
						openEditor({
							type: "steerAction",
							actionKey: optionValue(opt),
						});
					}
					return;
				}
			}
		}

		function openEditor(context: typeof editorContext, preFill?: string) {
			editorMode = true;
			editorContext = context;
			editor.setText(preFill ?? "");
			tui.requestRender();
		}

		function handleActionResult(result: ActionBarResult) {
			if (result.type === "action") {
				handleItemResult({ type: "action", value: result.key });
			} else if (result.type === "steerAction") {
				const actions = currentActions();
				const action = actions?.find((a) => a.key === result.key);
				openEditor({
					type: "steerAction",
					actionKey: result.key,
					label: action?.label,
				});
			} else if (result.type === "pureSteer") {
				openEditor({ type: "pureSteer" });
			}
		}

		function handleItemResult(result: PromptResult) {
			results.set(currentTab, result);

			if (config.autoResolve && results.size === config.items.length) {
				done({ items: results, userItems });
				return;
			}

			advanceToNext();
			tui.requestRender();
		}

		function tabStatuses(): TabStatus[] {
			return config.items.map((_, i) => {
				const result = results.get(i);
				if (result) {
					return result.type === "steer" ? "rejected" : "complete";
				}
				return i === currentTab ? "active" : "pending";
			});
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			const actions = currentActions();
			const options = currentOptions();
			const item = config.items[currentTab];
			const content = item?.content ?? (() => []);

			// Top border
			add(theme.fg("accent", GLYPH.hrule.repeat(width)));

			// Tab strip
			const labels = config.items.map((it) => it.label);
			add(
				renderTabStrip(
					labels,
					tabStatuses(),
					currentTab,
					width,
					theme,
					userItems,
				),
			);
			// Light separator
			add(
				theme.fg("dim", ` ${GLYPH.separator.repeat(Math.max(0, width - 2))}`),
			);

			// Content (cached per tab — only re-render on width change)
			const chromeLines = computeChromeLines(true, actions, options);
			const budget = contentBudget(chromeLines);
			const cached = contentCache.get(currentTab);
			if (!cached || cached.width !== width) {
				const rendered = content(theme, width - SCROLLBAR_GUTTER);
				contentCache.set(currentTab, {
					lines: rendered,
					width,
					hScroll: maxContentWidth(rendered) > width - SCROLLBAR_GUTTER,
				});
			}
			const entry = contentCache.get(currentTab);
			const contentLines = entry?.lines ?? [];
			const scrollState = scrollStates[currentTab] ?? {
				vOffset: 0,
				hOffset: 0,
			};
			const {
				lines: scrolled,
				needsVScroll,
				needsHScroll,
			} = renderScrollRegion(
				contentLines,
				scrollState,
				budget,
				width,
				theme,
				entry?.hScroll,
			);
			for (const line of scrolled) add(line);

			// Pad to budget only when scrolling (keeps height stable during scroll)
			if (needsVScroll) {
				const targetContentEnd = 1 + 2 + budget; // top border + tab lines + budget
				while (lines.length < targetContentEnd) {
					lines.push("");
				}
			}

			if (editorMode) {
				const editorLabel =
					editorContext?.type === "addItem"
						? "New item:"
						: editorContext?.label
							? `${editorContext.label} with note:`
							: editorContext?.type === "pureSteer"
								? "Feedback:"
								: "Note:";
				for (const line of renderNoteEditor(editor, width, theme, {
					label: editorLabel,
				})) {
					add(line);
				}
			} else {
				if (actions) {
					lines.push("");
					add(renderActionBar(actions, width, theme));
				}
				if (options) {
					lines.push("");
					for (const line of renderOptionList(options, optionIndex, theme)) {
						add(line);
					}
				}

				lines.push("");
				const hints = buildHints(true, needsVScroll, needsHScroll, !!actions);
				add(theme.fg("dim", ` ${hints.join(" · ")}`));
			}

			add(theme.fg("accent", GLYPH.hrule.repeat(width)));
			return lines;
		}

		return {
			render,
			handleInput,
			invalidate() {
				contentCache.clear();
			},
		};
	});
}

// ---- Helpers ----

/**
 * Compute total chrome lines for the panel (borders, tabs,
 * actions, options, hints) to calculate the content budget.
 */
function computeChromeLines(
	hasTabs: boolean,
	actions: Action[] | undefined,
	options: Option[] | undefined,
): number {
	let lines = 2; // top + bottom border
	if (hasTabs) lines += 2; // tab strip + separator
	if (actions) lines += 2; // blank + action bar
	if (options) lines += 2 + (options.length > 0 ? options.length : 0); // blank + options
	lines += 2; // blank + hint bar
	return lines;
}

/** Build the hint bar segments. */
function buildHints(
	hasTabs: boolean,
	needsVScroll: boolean,
	needsHScroll: boolean,
	hasActions: boolean,
): string[] {
	const hints: string[] = [];
	if (hasTabs) {
		hints.push("Tab navigate");
		hints.push("Ctrl+# jump");
		hints.push("+ add");
		hints.push("Ctrl+Enter submit");
	}
	if (!hasActions) {
		hints.push("↑↓ select");
		hints.push("Enter confirm");
	}
	hints.push("Esc cancel");
	if (needsVScroll) hints.push("Shift+↑↓ scroll");
	if (needsHScroll) hints.push("Shift+←→ pan");
	return hints;
}
