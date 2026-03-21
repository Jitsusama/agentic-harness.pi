/**
 * Workspace prompt: a stateful tabbed interaction panel.
 *
 * Unlike the tabbed prompt (where each tab produces one result),
 * workspace tabs are stateful workspaces where the user acts
 * many times. Tab completion is driven by external business
 * logic, not by result collection.
 *
 * Key differences from prompt-tabbed:
 *   - Per-view input handlers (get first crack at input)
 *   - External tab status via callback
 *   - No per-tab results: Ctrl+Enter submits, Escape cancels
 *   - Content invalidation for in-place state mutation
 *   - View-specific actions
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	isKeyRelease,
	Key,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { handleActionInput, renderActionBar } from "./action-bar.js";
import { buildNoteEditorTheme, renderNoteEditor } from "./note-editor.js";
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
	GLYPH,
	HSCROLL_CONTENT_WIDTH,
	SCROLLBAR_GUTTER,
	type TabStatus,
	type WorkspaceConfig,
	type WorkspaceInputContext,
	type WorkspaceResult,
	type WorkspaceView,
} from "./types.js";

/** Cache key for content: "tabIndex-viewIndex". */
function cacheKey(tab: number, view: number): string {
	return `${tab}-${view}`;
}

/** Show a workspace prompt panel. */
export async function showWorkspacePrompt(
	ctx: ExtensionContext,
	config: WorkspaceConfig,
): Promise<WorkspaceResult> {
	return ctx.ui.custom<WorkspaceResult>((tui, theme, _kb, done) => {
		let currentTab = 0;
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

		/** Scroll states per tab-view pair. */
		const scrollStates = new Map<string, ScrollState>();

		const editor = new Editor(tui, buildNoteEditorTheme(theme));

		let editorLabel = "Feedback:";

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

		function currentItem() {
			return config.items[currentTab];
		}

		function currentViews(): WorkspaceView[] {
			return currentItem()?.views ?? [];
		}

		function currentView(): WorkspaceView | undefined {
			return currentViews()[getViewIndex(currentTab)];
		}

		/** Get actions for the current view, falling back to global. */
		function currentActions(): Action[] | undefined {
			const view = currentView();
			return view?.actions ?? config.globalActions;
		}

		/** Build tab statuses from config callback. */
		function tabStatuses(): TabStatus[] {
			return config.items.map((_, i) => {
				if (i === currentTab) return "active";
				return config.tabStatus(i);
			});
		}

		editor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			editorMode = false;
			editor.setText("");

			if (trimmed) {
				done({ type: "steer", note: trimmed });
			} else {
				tui.requestRender();
			}
		};

		function buildInputContext(): WorkspaceInputContext {
			return {
				invalidate() {
					const tab = currentTab;
					const view = getViewIndex(tab);
					contentCache.delete(cacheKey(tab, view));
					tui.requestRender(true);
				},
				requestRender() {
					tui.requestRender(true);
				},
				scrollToLine(line: number) {
					const tab = currentTab;
					const view = getViewIndex(tab);
					const scroll = getScrollState(tab, view);
					const actions = currentActions();
					const chromeLines = computeChromeLines(true, actions, undefined);
					const budget = contentBudget(chromeLines);
					const margin = Math.min(3, Math.floor(budget / 4));

					if (line < scroll.vOffset + margin) {
						scroll.vOffset = Math.max(0, line - margin);
					} else if (line >= scroll.vOffset + budget - margin) {
						scroll.vOffset = line - budget + margin + 1;
					}
				},
				openEditor(label: string, preFill?: string) {
					editorLabel = label;
					editorMode = true;
					editor.setText(preFill ?? "");
					tui.requestRender();
				},
				done(result: WorkspaceResult) {
					done(result);
				},
			};
		}

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

		function handleInput(data: string) {
			if (isKeyRelease(data)) return;

			// Editor mode captures all input
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

			// Escape closes the panel
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			// Ctrl+Enter submits
			if (matchesKey(data, Key.ctrl("enter"))) {
				done({ type: "submit" });
				return;
			}

			// 1. View handleInput gets first crack
			const view = currentView();
			if (view?.handleInput) {
				const handled = view.handleInput(data, buildInputContext());
				if (handled) return;
			}

			// 2. Scroll
			const actions = currentActions();
			const chromeLines = computeChromeLines(true, actions, undefined);
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

			// 3. Tab navigation
			const tabResult = handleTabInput(data, currentTab, config.items.length);
			if (tabResult !== null) {
				currentTab = tabResult;
				tui.requestRender();
				return;
			}

			// 4. View switching (pressing the active view's key toggles back to the first view)
			const views = currentViews();
			if (views.length > 1) {
				for (let i = 0; i < views.length; i++) {
					const v = views[i];
					if (v && matchesKey(data, v.key)) {
						const target = i === getViewIndex(currentTab) ? 0 : i;
						activeViewIndex.set(currentTab, target);
						tui.requestRender();
						ensureViewContent(currentTab, target, 0);
						return;
					}
				}
			}

			// 5. View actions
			if (actions) {
				const result = handleActionInput(data, actions);
				if (result) {
					if (result.type === "action") {
						done({ type: "action", value: result.key });
					} else if (result.type === "pureSteer") {
						editorLabel = "Feedback:";
						editorMode = true;
						editor.setText("");
						tui.requestRender();
					} else if (result.type === "steerAction") {
						const action = actions.find((a) => a.key === result.key);
						editorLabel = action?.label ? `${action.label} note:` : "Note:";
						editorMode = true;
						editor.setText("");
						tui.requestRender();
					}
					return;
				}
			}

			// 6. Global steer (Shift+Enter)
			if (matchesKey(data, Key.shift("enter"))) {
				editorLabel = "Feedback:";
				editorMode = true;
				editor.setText("");
				tui.requestRender();
			}
		}

		function render(width: number): string[] {
			lastWidth = width;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			const actions = currentActions();
			const viewIdx = getViewIndex(currentTab);
			const views = currentViews();

			// Top border
			add(theme.fg("accent", GLYPH.hrule.repeat(width)));

			// Tab strip
			const labels = config.items.map((it) => it.label);
			add(renderTabStrip(labels, tabStatuses(), currentTab, width, theme));
			add(
				theme.fg("dim", ` ${GLYPH.separator.repeat(Math.max(0, width - 2))}`),
			);

			// Content
			const chromeLines = computeChromeLines(true, actions, undefined);
			const budget = contentBudget(chromeLines);
			const key = cacheKey(currentTab, viewIdx);

			const cached = contentCache.get(key);
			if (!cached || cached.width !== width) {
				ensureViewContent(currentTab, viewIdx, width);
			}

			const entry = contentCache.get(key);
			const isLoading = loadingViews.has(key);

			let contentLines: string[];
			if (isLoading || !entry) {
				contentLines = [` ${theme.fg("dim", "Loading…")}`];
			} else {
				contentLines = entry.lines;
			}

			const scrollState = getScrollState(currentTab, viewIdx);
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

			// Editor or action bar + hints
			if (editorMode) {
				for (const line of renderNoteEditor(editor, width, theme, {
					label: editorLabel,
				})) {
					add(line);
				}
			} else {
				if (actions) {
					lines.push("");
					add(renderActionBar(actions, width, theme, true));
				}

				lines.push("");
				add(
					buildHintBar({
						theme,
						hasTabs: true,
						needsVScroll,
						needsHScroll,
						hasActions: !!actions,
						allComplete: config.allComplete(),
						views: views.length > 1 ? views : undefined,
						activeViewIndex: viewIdx,
					}),
				);
			}

			// Bottom border
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
