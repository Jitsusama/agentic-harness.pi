/**
 * Tabbed prompt — a multi-item panel with tab navigation,
 * per-item results, and optional user-added items. Returns
 * all decisions or null on cancel.
 *
 * This is the tabbed variant. See prompt-single.ts for the
 * single-item variant.
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
	type Option,
	type PromptResult,
	SCROLLBAR_GUTTER,
	type TabbedPromptConfig,
	type TabbedResult,
	type TabStatus,
} from "./types.js";

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
		const contentCache = new Map<
			number,
			{ lines: string[]; width: number; hScroll: boolean }
		>();
		let editorContext: {
			type: "steerAction" | "pureSteer" | "editor" | "addItem" | "editItem";
			actionKey?: string;
			label?: string;
			index?: number;
		} | null = null;

		const scrollStates: ScrollState[] = config.items.map(() => ({
			vOffset: 0,
			hOffset: 0,
		}));
		const userTabScroll: ScrollState = { vOffset: 0, hOffset: 0 };
		const results = new Map<number, PromptResult>();
		const userItems: string[] = [];
		const editor = new Editor(tui, buildNoteEditorTheme(theme));

		/** Index of the virtual user tab (after all real tabs). */
		const userTabIndex = config.items.length;

		/** Whether the user tab is currently selected. */
		function isUserTab(): boolean {
			return config.canAddItems === true && currentTab === userTabIndex;
		}

		/** Total navigable tab count (real tabs + user tab when enabled). */
		function totalTabCount(): number {
			return config.items.length + (config.canAddItems ? 1 : 0);
		}

		/** Actions shown on the user tab. */
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
				contentCache.delete(userTabIndex);
				editorMode = false;
				editorContext = null;
				editor.setText("");
				tui.requestRender();
				return;
			}

			if (editorContext.type === "editItem") {
				const idx = editorContext.index ?? 0;
				userItems[idx] = trimmed;
				contentCache.delete(userTabIndex);
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

			// Tab navigation
			const tabResult = handleTabInput(data, currentTab, totalTabCount());
			if (tabResult !== null) {
				currentTab = tabResult;
				optionIndex = 0;
				tui.requestRender();
				return;
			}

			// User tab has its own input handling
			if (isUserTab()) {
				handleUserTabInput(data);
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
				cachedEntry?.hScroll ?? false,
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

		function handleUserTabInput(data: string) {
			const options = currentOptions();
			const actions = currentActions();

			// Scroll
			const chromeLines = computeChromeLines(true, actions, options);
			const budget = contentBudget(chromeLines);
			const cachedEntry = contentCache.get(currentTab);
			const scrollResult = handleScrollInput(
				data,
				userTabScroll,
				budget,
				cachedEntry?.lines.length ?? 0,
				cachedEntry?.hScroll ?? false,
			);
			if (scrollResult) {
				userTabScroll.vOffset = scrollResult.vOffset;
				userTabScroll.hOffset = scrollResult.hOffset;
				tui.requestRender();
				return;
			}

			// Option navigation (↑↓ through user items)
			if (options) {
				const result = handleOptionInput(data, userOptionIndex, options.length);
				if (result) {
					if (result.type === "navigate") {
						userOptionIndex = result.index;
						tui.requestRender();
					}
					// Select (Enter) does nothing — use Edit action
					return;
				}
			}

			// Action keys: Add, Edit, Delete
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
					contentCache.delete(userTabIndex);
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

		/** Build content lines for the user tab. */
		const userTabContent: ContentFn = () => {
			if (userItems.length === 0) return [];
			return ["  Your additions:"];
		};

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			const actions = currentActions();
			const options = currentOptions();
			const onUserTab = isUserTab();
			const item = onUserTab ? null : config.items[currentTab];
			const content = onUserTab
				? userTabContent
				: (item?.content ?? (() => []));

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
			const scrollState = onUserTab
				? userTabScroll
				: (scrollStates[currentTab] ?? { vOffset: 0, hOffset: 0 });
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
