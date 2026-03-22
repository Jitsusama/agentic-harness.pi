/**
 * Single prompt: an interactive panel with content, optional
 * actions and optional options. Returns the user's decision
 * or null on cancel.
 *
 * This is the non-tabbed variant. See prompt-tabbed.ts for
 * the tabbed multi-item variant.
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
import { type ActionBarResult, handleActionInput } from "./action-bar.js";
import { buildNoteEditorTheme, renderNoteEditor } from "./note-editor.js";
import {
	handleOptionInput,
	optionValue,
	renderOptionList,
} from "./option-list.js";
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
import { GLYPH, type PromptResult, type SinglePromptConfig } from "./types.js";

/** What the note editor is being used for in a single prompt. */
type EditorContext = {
	type: "annotatedAction" | "annotatedOption" | "redirect" | "optionEditor";
	key?: string;
	label?: string;
};

/**
 * Create the controller for a single interactive prompt.
 *
 * Owns all mutable state (scroll position, option index, editor
 * mode) and provides render, input and invalidation handlers.
 */
function createSingleController(
	config: SinglePromptConfig,
	tui: TUI,
	theme: Theme,
	done: (result: PromptResult | null) => void,
) {
	const scroll: ScrollState = { vOffset: 0, hOffset: 0 };
	let optionIndex = 0;
	let editorMode = false;
	let editorContext: EditorContext | null = null;
	let cachedContent: string[] | null = null;
	let cachedHScroll = false;
	let cachedWidth = -1;
	const hScrollEnabled = config.allowHScroll === true;
	const editor = new Editor(tui, buildNoteEditorTheme(theme));

	const { actions, options } = config;

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
				key: editorContext.key ?? "",
				note: trimmed,
			});
		} else if (editorContext.type === "annotatedOption") {
			done({
				type: "option",
				value: editorContext.key ?? "",
				note: trimmed,
			});
		} else if (editorContext.type === "optionEditor") {
			done({
				type: "option",
				value: editorContext.key ?? "",
				editorText: trimmed,
			});
		}
	};

	function openEditor(context: EditorContext, preFill?: string) {
		editorMode = true;
		editorContext = context;
		editor.setText(preFill ?? "");
		tui.requestRender();
	}

	function handleActionResult(result: ActionBarResult) {
		if (result.type === "action") {
			done({ type: "action", key: result.key });
		} else if (result.type === "annotatedAction") {
			const action = actions?.find((a) => a.key === result.key);
			openEditor({
				type: "annotatedAction",
				key: result.key,
				label: action?.label,
			});
		} else if (result.type === "redirect") {
			openEditor({ type: "redirect" });
		}
	}

	function handleInput(data: string) {
		// We drop release events because they duplicate press events
		// under Kitty protocol flag 2 and would leak characters
		// into the NoteEditor or double-fire actions.
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

		// Scroll handling
		const titleLines = config.title ? 2 : 0;
		const chromeLines =
			computeChromeLines(false, actions, options) + titleLines;
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

		if (actions) {
			const result = handleActionInput(data, actions);
			if (result) {
				handleActionResult(result);
				return;
			}
		}

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
							{ type: "optionEditor", key: optionValue(opt) },
							opt.editorPreFill,
						);
					} else if (opt) {
						done({ type: "option", value: optionValue(opt) });
					}
				} else if (result.type === "cancel") {
					done(null);
				}
				return;
			}

			if (matchesKey(data, Key.shift("enter")) && options.length > 0) {
				const opt = options[optionIndex];
				if (opt) {
					openEditor({
						type: "annotatedOption",
						key: optionValue(opt),
					});
				}
				return;
			}
		}
	}

	function render(width: number): string[] {
		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));
		const titleLines = config.title ? 2 : 0;

		add(theme.fg("accent", GLYPH.hrule.repeat(width)));

		if (config.title) {
			add(` ${theme.fg("accent", theme.bold(config.title))}`);
			add("");
		}

		const chromeLines =
			computeChromeLines(false, actions, options) + titleLines;
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
			while (lines.length < budget + 1 + titleLines) {
				lines.push("");
			}
		}

		if (editorMode) {
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
			if (options) {
				lines.push("");
				for (const line of renderOptionList(options, optionIndex, theme)) {
					add(line);
				}
			}

			lines.push("");
			for (const line of renderFooter({
				theme,
				width,
				actions,
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
			cachedContent = null;
		},
	};
}

/** Show a single interactive prompt panel. */
export async function showSinglePrompt(
	ctx: ExtensionContext,
	config: SinglePromptConfig,
): Promise<PromptResult | null> {
	return ctx.ui.custom<PromptResult | null>((tui, theme, _kb, done) =>
		createSingleController(config, tui, theme, done),
	);
}
