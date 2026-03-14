/**
 * Content renderer — themed rendering of markdown, diffs, and
 * code into display-ready lines.
 *
 * Three explicit functions. The caller always knows what type
 * of content they have. No auto-detection.
 *
 * Pure rendering module with no UI dependencies. Each function
 * takes raw text, a theme, and a width, returning themed
 * string[] for display.
 */

import {
	getLanguageFromPath,
	getMarkdownTheme,
	highlightCode as piHighlightCode,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Markdown, truncateToWidth } from "@mariozechner/pi-tui";

// ---- Markdown ----

/**
 * Render markdown text to themed display lines.
 * Also handles plain text (markdown is a superset).
 *
 * Delegates to Pi's Markdown component for full-featured
 * parsing (tables, nested lists, code fences with syntax
 * highlighting, blockquotes, etc.).
 */
export function renderMarkdown(
	text: string,
	_theme: Theme,
	width: number,
): string[] {
	const mdTheme = getMarkdownTheme();
	const md = new Markdown(text, 1, 0, mdTheme);
	return md.render(width);
}

// ---- Diff ----

/**
 * Render unified diff output with coloring.
 *
 * + lines → success (green), - lines → error (red),
 * @@ headers → accent, file headers → bold,
 * context → default text.
 */
export function renderDiff(
	text: string,
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	for (const line of text.split("\n")) {
		let themed: string;

		if (line.startsWith("diff --git") || line.startsWith("index ")) {
			themed = theme.fg("dim", theme.bold(` ${line}`));
		} else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
			themed = theme.bold(` ${line}`);
		} else if (line.startsWith("@@")) {
			themed = theme.fg("accent", ` ${line}`);
		} else if (line.startsWith("+")) {
			themed = theme.fg("toolDiffAdded", ` ${line}`);
		} else if (line.startsWith("-")) {
			themed = theme.fg("toolDiffRemoved", ` ${line}`);
		} else {
			themed = theme.fg("toolDiffContext", ` ${line}`);
		}

		lines.push(truncateToWidth(themed, width));
	}

	return lines;
}

// ---- Code ----

export interface CodeRenderOptions {
	/** First line number (default: 1). */
	startLine?: number;
	/** Set of line numbers to highlight with accent. */
	highlightLines?: Set<number>;
	/** Language for syntax highlighting (auto-detects if omitted). */
	language?: string;
}

/**
 * Render code with line numbers and syntax highlighting.
 *
 * Line numbers are dim and right-aligned. A │ separator
 * divides numbers from content. Highlighted lines use accent.
 * Code is syntax-highlighted using cli-highlight when possible.
 */
export function renderCode(
	text: string,
	theme: Theme,
	width: number,
	options?: CodeRenderOptions,
): string[] {
	const startLine = options?.startLine ?? 1;
	const highlights = options?.highlightLines;
	const codeLines = piHighlightCode(text, options?.language);
	const lastLineNum = startLine + codeLines.length - 1;
	const gutterWidth = String(lastLineNum).length;
	const lines: string[] = [];

	for (let i = 0; i < codeLines.length; i++) {
		const lineNum = startLine + i;
		const numStr = String(lineNum).padStart(gutterWidth);
		const isHighlighted = highlights?.has(lineNum);

		const gutter = theme.fg("dim", `${numStr} │ `);
		const codeLine = codeLines[i] ?? "";
		const content = isHighlighted ? theme.fg("accent", codeLine) : codeLine;

		lines.push(truncateToWidth(gutter + content, width));
	}

	return lines;
}

// ---- Re-exports ----

/** Derive a syntax highlighting language from a file path. */
export const languageFromPath = getLanguageFromPath;
