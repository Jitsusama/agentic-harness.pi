/**
 * Tabbed prompt: a multi-item panel with tab navigation,
 * per-item views, per-item results and optional user-added
 * items. Returns all decisions or null on cancel.
 *
 * Each item has one or more views (content modes). Items with
 * multiple views show view key-hints in the hint bar. Pressing
 * a view's key switches the content area.
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
import { buildHintBar, computeChromeLines } from "./panel-layout.js";
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
	type ContentFn,
	GLYPH,
	HSCROLL_CONTENT_WIDTH,
	type Option,
	type PromptResult,
	type PromptView,
	SCROLLBAR_GUTTER,
	type TabbedPromptConfig,
	type TabbedResult,
	type TabStatus,
} from "./types.js";

/** Cache key for content: "tabIndex-viewIndex". */
function cacheKey(tab: number, view: number): string {
	return `${tab}-${view}`;
}

/** Show a tabbed interactive prompt panel. */
export async function showTabbedPrompt(
	ctx: ExtensionContext,
	config: TabbedPromptConfig,
): Promise<TabbedResult | null> {
	return ctx.ui.custom<TabbedResult | null>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let userOptionIndex = 0;
		let editorMode = false;
		let lastWidth = process.stdout.columns || 80;

		/** Active view index per tab. */
		const activeViewIndex = new Map<number, number>();

		/** Content cache keyed by "tabIndex-viewIndex". */
		const contentCache = new Map<
			string,
			{ lines: string[]; width: number; hScroll: boolean }
		>();

		/** Tabs with an async view currently loading. */
		const loadingViews = new Set<string>();

		let editorContext: {
			type: "steerAction" | "pureSteer" | "editor" | "addItem" | "editItem";
			actionKey?: string;
			label?: string;
			index?: number;
		} | null = null;

		const scrollStates = new Map<string, ScrollState>();
		const userTabScroll: ScrollState = { vOffset: 0, hOffset: 0 };
		const results = new Map<number, PromptResult>();
		const userItems: string[] = [];
		const editor = new Editor(tui, buildNoteEditorTheme(theme));

		const userTabIndex = config.items.length;

		function isUserTab(): boolean {
			return config.canAddItems === true && currentTab === userTabIndex;
		}

		function totalTabCount(): number {
			return config.items.length + (config.canAddItems ? 1 : 0);
		}

		function getViewIndex(tab: number): number {
			return activeViewIndex.get(tab) ?? 0;
		}

		function getScrollState(tab: number, view: number): ScrollState {
			const key = cacheKey(tab, view);
			let s = scrollStates.get(key);
			if (!s) {
				s = { vOffset: 0, hOffset: 0 };
				scrollStates.set(key, s);
			}
			return s;
		}

		/** Get the views for the current tab's item. */
		function currentViews(): PromptView[] {
			return config.items[currentTab]?.views ?? [];
		}

		const userTabActions: Action[] = [
			{ key: "a", label: "Add" },
			{ key: "e", label: "Edit" },
			{ key: "d", label: "Delete" },
		];

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
				contentCache.delete(cacheKey(userTabIndex, 0));
				editorMode = false;
				editorContext = null;
				editor.setText("");
				tui.requestRender();
				return;
			}

			if (editorContext.type === "editItem") {
				const idx = editorContext.index ?? 0;
				userItems[idx] = trimmed;
				contentCache.delete(cacheKey(userTabIndex, 0));
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
			if (isUserTab()) return userTabActions;
			return config.items[currentTab]?.actions ?? config.actions;
		}

		function currentOptions(): Option[] | undefined {
			if (isUserTab()) {
				if (userItems.length === 0) return undefined;
				return userItems.map((text, i) => ({
					label: text,
					value: String(i),
				}));
			}
			return config.items[currentTab]?.options ?? config.options;
		}

		function handleInput(data: string) {
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

			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			if (matchesKey(data, Key.ctrl("enter"))) {
				done({ items: results, userItems });
				return;
			}

			// Tab navigation
			const tabResult = handleTabInput(data, currentTab, totalTabCount());
			if (tabResult !== null) {
				currentTab = tabResult;
				optionIndex = 0;
				tui.requestRender();
				return;
			}

			if (isUserTab()) {
				handleUserTabInput(data);
				return;
			}

			// Check view switching before actions so their keys don't conflict
			const views = currentViews();
			if (views.length > 1) {
				for (let i = 0; i < views.length; i++) {
					const view = views[i];
					if (view && matchesKey(data, view.key)) {
						activeViewIndex.set(currentTab, i);
						tui.requestRender();
						// Trigger async load if needed
						ensureViewContent(currentTab, i, 0);
						return;
					}
				}
			}

			// Scroll
			const actions = currentActions();
			const options = currentOptions();
			const chromeLines = computeChromeLines(true, actions, options);
			const budget = contentBudget(chromeLines);
			const viewIdx = getViewIndex(currentTab);
			const scrollState = getScrollState(currentTab, viewIdx);
			const key = cacheKey(currentTab, viewIdx);
			const cachedEntry = contentCache.get(key);
			const maxH = Math.max(
				0,
				maxContentWidth(cachedEntry?.lines ?? []) -
					(lastWidth - SCROLLBAR_GUTTER),
			);
			const scrollResult = handleScrollInput(
				data,
				scrollState,
				budget,
				cachedEntry?.lines.length ?? 0,
				cachedEntry?.hScroll ?? false,
				maxH,
			);
			if (scrollResult) {
				scrollStates.set(key, scrollResult);
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

		function handleUserTabInput(data: string) {
			const options = currentOptions();
			const actions = currentActions();

			const chromeLines = computeChromeLines(true, actions, options);
			const budget = contentBudget(chromeLines);
			const key = cacheKey(currentTab, 0);
			const cachedEntry = contentCache.get(key);
			const userMaxH = Math.max(
				0,
				maxContentWidth(cachedEntry?.lines ?? []) -
					(lastWidth - SCROLLBAR_GUTTER),
			);
			const scrollResult = handleScrollInput(
				data,
				userTabScroll,
				budget,
				cachedEntry?.lines.length ?? 0,
				cachedEntry?.hScroll ?? false,
				userMaxH,
			);
			if (scrollResult) {
				userTabScroll.vOffset = scrollResult.vOffset;
				userTabScroll.hOffset = scrollResult.hOffset;
				tui.requestRender();
				return;
			}

			if (options) {
				const result = handleOptionInput(data, userOptionIndex, options.length);
				if (result) {
					if (result.type === "navigate") {
						userOptionIndex = result.index;
						tui.requestRender();
					}
					return;
				}
			}

			const actionResult = handleActionInput(data, userTabActions);
			if (actionResult && actionResult.type === "action") {
				if (actionResult.key === "a") {
					openEditor({ type: "addItem" });
				} else if (actionResult.key === "e" && userItems.length > 0) {
					openEditor(
						{ type: "editItem", index: userOptionIndex },
						userItems[userOptionIndex],
					);
				} else if (actionResult.key === "d" && userItems.length > 0) {
					userItems.splice(userOptionIndex, 1);
					if (userOptionIndex >= userItems.length && userItems.length > 0) {
						userOptionIndex = userItems.length - 1;
					}
					contentCache.delete(cacheKey(userTabIndex, 0));
					tui.requestRender();
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

		/** User tab content: static. */
		const userTabContent: ContentFn = () => {
			if (userItems.length === 0) return [];
			return ["  Your additions:"];
		};

		/**
		 * Ensure content is cached for a given tab and view.
		 * If the view's content is async, starts loading and
		 * triggers a re-render when done.
		 */
		function ensureViewContent(tab: number, view: number, width: number): void {
			const key = cacheKey(tab, view);
			if (contentCache.has(key) || loadingViews.has(key)) return;

			const item = config.items[tab];
			const viewDef = item?.views[view];
			if (!viewDef) return;

			const itemHScroll = item?.allowHScroll ?? config.allowHScroll ?? false;
			const contentWidth = itemHScroll
				? HSCROLL_CONTENT_WIDTH
				: width - SCROLLBAR_GUTTER;
			const result = viewDef.content(theme, contentWidth);

			if (result instanceof Promise) {
				loadingViews.add(key);
				result.then((lines) => {
					loadingViews.delete(key);
					contentCache.set(key, {
						lines,
						width,
						hScroll:
							itemHScroll && maxContentWidth(lines) > width - SCROLLBAR_GUTTER,
					});
					tui.requestRender();
				});
			} else {
				contentCache.set(key, {
					lines: result,
					width,
					hScroll:
						itemHScroll && maxContentWidth(result) > width - SCROLLBAR_GUTTER,
				});
			}
		}

		function render(width: number): string[] {
			lastWidth = width;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			const actions = currentActions();
			const options = currentOptions();
			const onUserTab = isUserTab();
			const viewIdx = getViewIndex(currentTab);
			const views = currentViews();

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
					config.canAddItems ? userItems.length : -1,
				),
			);
			add(
				theme.fg("dim", ` ${GLYPH.separator.repeat(Math.max(0, width - 2))}`),
			);

			// Content
			const chromeLines = computeChromeLines(true, actions, options);
			const budget = contentBudget(chromeLines);
			const key = cacheKey(currentTab, viewIdx);

			if (onUserTab) {
				// User tab content
				const cached = contentCache.get(key);
				if (!cached || cached.width !== width) {
					const rendered = userTabContent(theme, width - SCROLLBAR_GUTTER);
					contentCache.set(key, {
						lines: rendered,
						width,
						hScroll: false,
					});
				}
			} else {
				// Item view content: may be async
				const cached = contentCache.get(key);
				if (!cached || cached.width !== width) {
					ensureViewContent(currentTab, viewIdx, width);
				}
			}

			const entry = contentCache.get(key);
			const isLoading = loadingViews.has(key);

			let contentLines: string[];
			if (isLoading || !entry) {
				contentLines = [` ${theme.fg("dim", "Loading…")}`];
			} else {
				contentLines = entry.lines;
			}

			const scrollState = onUserTab
				? userTabScroll
				: getScrollState(currentTab, viewIdx);
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

			if (needsVScroll) {
				const targetContentEnd = 1 + 2 + budget;
				while (lines.length < targetContentEnd) {
					lines.push("");
				}
			}

			if (editorMode) {
				const editorLabel =
					editorContext?.type === "addItem"
						? "New item:"
						: editorContext?.type === "editItem"
							? "Edit item:"
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
				if (options) {
					lines.push("");
					const oIdx = onUserTab ? userOptionIndex : optionIndex;
					for (const line of renderOptionList(options, oIdx, theme)) {
						add(line);
					}
				}
				if (actions) {
					lines.push("");
					add(renderActionBar(actions, width, theme, !onUserTab));
				}

				lines.push("");
				add(
					buildHintBar({
						theme,
						hasTabs: true,
						needsVScroll,
						needsHScroll,
						hasActions: !!actions && !onUserTab,
						isUserTab: onUserTab,
						allComplete: results.size >= config.items.length,
						views: !onUserTab && views.length > 1 ? views : undefined,
						activeViewIndex: viewIdx,
					}),
				);
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
