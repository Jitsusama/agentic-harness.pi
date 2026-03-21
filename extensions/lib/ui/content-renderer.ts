/**
 * Content renderer: themed rendering of markdown, diffs, and
 * code into display-ready lines.
 *
 * Three explicit functions. The caller always knows what type
 * of content they have. No auto-detection.
 *
 * Pure rendering module with no UI dependencies. Each function
 * takes raw text, a theme and a width, returning themed
 * string[] for display.
 */

import {
	getLanguageFromPath,
	getMarkdownTheme,
	highlightCode as piHighlightCode,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Markdown, truncateToWidth } from "@mariozechner/pi-tui";
import { SCROLLBAR_GUTTER } from "./types.js";

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
	// Markdown is prose, so we cap it to terminal width to keep
	// things readable. When horizontal scrolling is enabled, the
	// content functions get a huge width (10,000) so code and
	// diffs can extend beyond the viewport, but prose still
	// needs to wrap.
	const cols = process.stdout.columns;
	const cappedWidth =
		cols && cols > 0 ? Math.min(width, cols - SCROLLBAR_GUTTER) : width;

	const mdTheme = getMarkdownTheme();
	const md = new Markdown(text, 1, 0, mdTheme);
	return md.render(cappedWidth);
}

// ---- Diff ----

/**
 * Render unified diff output with colouring.
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
	/** Pre-highlighted lines from preHighlightCode(). Skips highlighting when provided. */
	preHighlighted?: string[];
	/** Tab width in spaces (default: 4). */
	tabWidth?: number;
}

/** Default number of spaces per tab character. */
const DEFAULT_TAB_WIDTH = 3;

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
	const highlighted =
		options?.preHighlighted ??
		piHighlightCode(text.trimEnd(), options?.language);
	return formatHighlightedCode(highlighted, theme, width, options);
}

/**
 * Pre-highlight code text for later rendering.
 * Call this once upfront, then pass the result via
 * CodeRenderOptions.preHighlighted to avoid re-highlighting.
 */
export function preHighlightCode(text: string, language?: string): string[] {
	return piHighlightCode(text.trimEnd(), language);
}

/** Format pre-highlighted code lines with gutter and truncation. */
function formatHighlightedCode(
	codeLines: string[],
	theme: Theme,
	width: number,
	options?: CodeRenderOptions,
): string[] {
	const startLine = options?.startLine ?? 1;
	const highlights = options?.highlightLines;
	const tabSpaces = " ".repeat(options?.tabWidth ?? DEFAULT_TAB_WIDTH);
	const lastLineNum = startLine + codeLines.length - 1;
	const gutterWidth = String(lastLineNum).length;
	const lines: string[] = [];

	// Track ANSI color state across lines so multi-line constructs
	// (comments, strings) keep their colour after the gutter resets it.
	let activeEscapes = "";

	for (let i = 0; i < codeLines.length; i++) {
		const lineNum = startLine + i;
		const numStr = String(lineNum).padStart(gutterWidth);
		const isHighlighted = highlights?.has(lineNum);

		const marker = isHighlighted ? theme.fg("accent", "▎") : " ";
		const gutter = `${marker}${theme.fg("dim", `${numStr} │ `)}`;
		const codeLine = (codeLines[i] ?? "").replaceAll("\t", tabSpaces);

		// Restore colour state from previous line, then emit this line
		lines.push(truncateToWidth(`${gutter}${activeEscapes}${codeLine}`, width));

		// Update active escapes by scanning this line's ANSI sequences
		activeEscapes = trackAnsiState(activeEscapes, codeLine);
	}

	return lines;
}

/**
 * Track ANSI escape state through a line of text.
 * Returns the active escape string to prepend to the next line.
 * Resets on \x1b[0m or \x1b[39m (colour reset).
 */
function trackAnsiState(current: string, line: string): string {
	let state = current;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			const start = i;
			i += 2;
			while (i < line.length && !/[A-Za-z]/.test(line[i] ?? "")) i++;
			i++; // consume the final letter
			const seq = line.slice(start, i);
			if (seq === "\x1b[0m" || seq === "\x1b[m" || seq === "\x1b[39m") {
				state = "";
			} else {
				state = seq;
			}
		} else {
			i++;
		}
	}
	return state;
}

// ---- Re-exports ----

/** Derive a syntax highlighting language from a file path. */
export const languageFromPath = getLanguageFromPath;
