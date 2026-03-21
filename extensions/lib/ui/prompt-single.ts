/**
 * Single prompt: an interactive panel with content, optional
 * actions and optional options. Returns the user's decision
 * or null on cancel.
 *
 * This is the non-tabbed variant. See prompt-tabbed.ts for
 * the tabbed multi-item variant.
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
import {
	GLYPH,
	HSCROLL_CONTENT_WIDTH,
	type PromptResult,
	SCROLLBAR_GUTTER,
	type SinglePromptConfig,
} from "./types.js";

/** Show a single interactive prompt panel. */
export async function showSinglePrompt(
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
		const hScrollEnabled = config.allowHScroll === true;
		let editorContext: {
			type: "annotatedAction" | "redirect" | "editor";
			actionKey?: string;
			label?: string;
		} | null = null;
		const editor = new Editor(tui, buildNoteEditorTheme(theme));

		const actions = config.actions;
		const options = config.options;

		editor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) {
				// An empty submit cancels the editor.
				editorMode = false;
				editorContext = null;
				editor.setText("");
				tui.requestRender();
				return;
			}

			if (!editorContext) return;

			if (editorContext.type === "redirect") {
				done({ type: "redirect", note: trimmed });
			} else if (editorContext.type === "annotatedAction") {
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
			// We drop release events because they duplicate press events
			// under Kitty protocol flag 2 and would leak characters
			// into the NoteEditor or double-fire actions.
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
							type: "annotatedAction",
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
			} else if (result.type === "annotatedAction") {
				const action = actions?.find((a) => a.key === result.key);
				openEditor({
					type: "annotatedAction",
					actionKey: result.key,
					label: action?.label,
				});
			} else if (result.type === "redirect") {
				openEditor({ type: "redirect" });
			}
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			// Top border
			add(theme.fg("accent", GLYPH.hrule.repeat(width)));

			// Content (cached: only re-render on width change)
			const chromeLines = computeChromeLines(false, actions, options);
			const budget = contentBudget(chromeLines);
			if (!cachedContent || width !== cachedWidth) {
				const contentWidth = hScrollEnabled
					? HSCROLL_CONTENT_WIDTH
					: width - SCROLLBAR_GUTTER;
				cachedContent = config.content(theme, contentWidth);
				cachedHScroll =
					hScrollEnabled &&
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

			// We pad to budget only when scrolling to keep height stable.
			if (needsVScroll) {
				while (lines.length < budget + 1) {
					lines.push("");
				}
			}

			if (editorMode) {
				// NoteEditor
				const editorLabel = editorContext?.label
					? `${editorContext.label} with note:`
					: editorContext?.type === "redirect"
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
				add(
					buildHintBar({
						theme,
						hasTabs: false,
						needsVScroll,
						needsHScroll,
						hasActions: !!actions,
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
				cachedContent = null;
			},
		};
	});
}
