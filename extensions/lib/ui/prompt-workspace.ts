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

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	isKeyRelease,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { handleActionInput, isShiftEscape } from "./action-bar.js";
import { buildNoteEditorTheme, renderNoteEditor } from "./note-editor.js";
import { computeChromeLines, renderFooter } from "./panel-layout.js";
import {
	contentBudget,
	HSCROLL_CONTENT_WIDTH,
	handleScrollInput,
	maxContentWidth,
	renderScrollRegion,
	SCROLLBAR_GUTTER,
	type ScrollState,
} from "./scroll-region.js";
import { handleTabInput, renderTabStrip } from "./tab-strip.js";
import {
	GLYPH,
	type KeyAction,
	type TabStatus,
	type WorkspaceDoneInput,
	type WorkspaceInputContext,
	type WorkspacePromptConfig,
	type WorkspaceResult,
	type WorkspaceView,
} from "./types.js";

/** Cache key for content: "tabIndex-viewIndex". */
function cacheKey(tab: number, view: number): string {
	return `${tab}-${view}`;
}

/**
 * Create the controller for a workspace prompt.
 *
 * Owns all mutable state (tab index, scroll positions, editor
 * mode) and provides render, input and invalidation handlers.
 * Tab completion is driven externally via config callbacks.
 */
function createWorkspaceController(
	config: WorkspacePromptConfig,
	tui: TUI,
	theme: Theme,
	rawDone: (result: WorkspaceResult) => void,
) {
	let currentTab = 0;
	let editorMode = false;
	let editorLabel = "Feedback:";
	let editorCallback: ((text: string) => void) | null = null;

	/** Inject the active tab index into every non-null result. */
	function done(result: WorkspaceDoneInput) {
		rawDone(result ? { ...result, tabIndex: currentTab } : null);
	}
	let lastWidth = process.stdout.columns || 80;

	const activeViewIndex = new Map<number, number>();
	const contentCache = new Map<
		string,
		{ lines: string[]; width: number; hScroll: boolean }
	>();
	const loadingViews = new Set<string>();
	const scrollStates = new Map<string, ScrollState>();
	const editor = new Editor(tui, buildNoteEditorTheme(theme));

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

	function currentActions(): KeyAction[] | undefined {
		const view = currentView();
		return view?.actions ?? config.globalActions;
	}

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

		if (editorCallback) {
			const cb = editorCallback;
			editorCallback = null;
			if (trimmed) cb(trimmed);
			tui.requestRender();
		} else if (trimmed) {
			done({ type: "redirect", note: trimmed });
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
			scrollToContentLine(line: number) {
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
			openEditor(
				label: string,
				preFill?: string,
				onSubmit?: (text: string) => void,
			) {
				editorLabel = label;
				editorCallback = onSubmit ?? null;
				editorMode = true;
				editor.setText(preFill ?? "");
				tui.requestRender();
			},
			done(result: WorkspaceDoneInput) {
				done(result);
			},
		};
	}

	function ensureViewContent(tab: number, view: number, width: number): void {
		const key = cacheKey(tab, view);
		if (loadingViews.has(key)) return;
		const existing = contentCache.get(key);
		if (existing) {
			// Re-render when the real width arrives after a width-0
			// prefetch (view switching passes 0 before render provides
			// the actual terminal width).
			if (width > 0 && existing.width !== width) {
				contentCache.delete(key);
			} else {
				return;
			}
		}

		const item = config.items[tab];
		const viewDef = item?.views[view];
		if (!viewDef) return;

		const viewHScroll =
			viewDef.allowHScroll ??
			item?.allowHScroll ??
			config.allowHScroll ??
			false;
		const contentWidth = viewHScroll
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
						viewHScroll && maxContentWidth(lines) > width - SCROLLBAR_GUTTER,
				});
				tui.requestRender();
			});
		} else {
			contentCache.set(key, {
				lines: result,
				width,
				hScroll:
					viewHScroll && maxContentWidth(result) > width - SCROLLBAR_GUTTER,
			});
		}
	}

	function handleInput(data: string) {
		if (isKeyRelease(data)) return;

		if (editorMode) {
			if (matchesKey(data, Key.escape)) {
				editorMode = false;
				editorCallback = null;
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
			done({ type: "submit" });
			return;
		}

		// View input handlers get first crack at input.
		const view = currentView();
		if (view?.handleInput) {
			const handled = view.handleInput(data, buildInputContext());
			if (handled) return;
		}

		// Scroll handling
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

		// Tab navigation
		const tabResult = handleTabInput(data, currentTab, config.items.length);
		if (tabResult !== null) {
			currentTab = tabResult;
			tui.requestRender();
			return;
		}

		// View switching (pressing the active view's key toggles back to the first view).
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

		// View actions
		if (actions) {
			const result = handleActionInput(data, actions);
			if (result) {
				if (result.type === "action") {
					done({ type: "action", key: result.key });
				} else if (result.type === "redirect") {
					editorLabel = "Feedback:";
					editorMode = true;
					editor.setText("");
					tui.requestRender();
				} else if (result.type === "annotatedAction") {
					const action = actions.find((a) => a.key === result.key);
					editorLabel = action?.label ? `${action.label} note:` : "Note:";
					editorMode = true;
					editor.setText("");
					tui.requestRender();
				}
				return;
			}
		}

		// Global redirect via Shift+Escape.
		if (isShiftEscape(data)) {
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

		add(theme.fg("accent", GLYPH.hrule.repeat(width)));

		const labels = config.items.map((it) => it.label);
		add(renderTabStrip(labels, tabStatuses(), currentTab, width, theme));
		add(theme.fg("dim", ` ${GLYPH.separator.repeat(Math.max(0, width - 2))}`));

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

		if (editorMode) {
			for (const line of renderNoteEditor(editor, width, theme, {
				label: editorLabel,
			})) {
				add(line);
			}
		} else {
			const view = currentView();
			lines.push("");
			for (const line of renderFooter({
				theme,
				width,
				actions,
				hasTabs: true,
				allComplete: config.allComplete(),
				views: views.length > 1 ? views : undefined,
				activeViewIndex: viewIdx,
				enterHint: view?.enterHint,
				needsVScroll,
				needsHScroll,
			})) {
				add(line);
			}
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
}

/** Show a workspace prompt panel. */
export async function showWorkspacePrompt(
	ctx: ExtensionContext,
	config: WorkspacePromptConfig,
): Promise<WorkspaceResult> {
	return ctx.ui.custom<WorkspaceResult>((tui, theme, _kb, done) =>
		createWorkspaceController(config, tui, theme, done),
	);
}
