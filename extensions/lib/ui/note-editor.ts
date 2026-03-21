/**
 * NoteEditor: inline editor for steer annotations and free-form
 * input.
 *
 * Wraps Pi's Editor with specific styling (┃ border bars) and
 * compact single-line behaviour.
 *
 * Renders:
 *   ┃ fix the typo in the subject line_                        ┃
 *   Enter submit · Esc back
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	type Editor,
	type EditorTheme,
	truncateToWidth,
} from "@mariozechner/pi-tui";

export interface NoteEditorConfig {
	/** Label shown above the editor (e.g., "Approving with note:"). */
	label?: string;
	/** Pre-fill text for the editor. */
	preFill?: string;
}

/** Build a Pi Editor theme with accent borders. */
export function buildNoteEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s: string) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		},
	};
}

/**
 * Render the inline note editor with bordered styling.
 * Returns lines to display in the panel.
 */
export function renderNoteEditor(
	editor: Editor,
	width: number,
	theme: Theme,
	config?: NoteEditorConfig,
): string[] {
	const lines: string[] = [];

	lines.push("");

	if (config?.label) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", config.label)}`, width));
	}

	// We render the editor content with ┃ border bars.
	for (const line of editor.render(width - 4)) {
		lines.push(`  ┃ ${line}`);
	}

	lines.push("");
	lines.push(
		truncateToWidth(`  ${theme.fg("dim", "Enter submit · Esc back")}`, width),
	);

	return lines;
}
