/**
 * Content renderer — themed rendering of markdown, diffs, and
 * code into display-ready lines.
 *
 * Pure rendering module with no UI dependencies. Each function
 * takes raw text, a theme, and a width, returning themed
 * string[] for display.
 */

import {
	getLanguageFromPath,
	highlightCode as piHighlightCode,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

// ---- Markdown ----

/**
 * Render markdown with theme-aware coloring.
 *
 * Handles: headers, blockquotes, list items, code fences,
 * bold, italic, and inline code. Paragraphs are hard-wrapped
 * to width. This is a light renderer for TUI display — not a
 * full markdown parser.
 */
export function renderMarkdown(
	text: string,
	theme: Theme,
	width: number,
): string[] {
	const wrapW = terminalWrapWidth(width);
	const lines: string[] = [];
	const raw = text.split("\n");
	let inCodeFence = false;
	let codeFenceLang = "";
	let codeFenceBuffer: string[] = [];

	for (const line of raw) {
		// Code fence toggle
		if (line.trimStart().startsWith("```")) {
			if (!inCodeFence) {
				// Opening fence — extract language
				inCodeFence = true;
				codeFenceLang = line.trimStart().slice(3).trim().toLowerCase();
				codeFenceBuffer = [];
				lines.push(truncateToWidth(theme.fg("dim", ` ${line}`), width));
			} else {
				// Closing fence — render the buffered block
				inCodeFence = false;
				const codeText = codeFenceBuffer.join("\n");

				if (codeFenceLang === "diff") {
					// Diff blocks get red/green/white coloring
					for (const dl of renderDiff(codeText, theme, width)) {
						lines.push(dl);
					}
				} else {
					// Syntax highlight using pi's theme-aware highlighter
					const highlighted = piHighlightCode(
						codeText,
						codeFenceLang || undefined,
					);
					for (const hl of highlighted) {
						lines.push(truncateToWidth(` ${hl}`, width));
					}
				}

				codeFenceBuffer = [];
				codeFenceLang = "";
				lines.push(truncateToWidth(theme.fg("dim", ` ${line}`), width));
			}
			continue;
		}

		// Inside a code fence — buffer for batch highlighting
		if (inCodeFence) {
			codeFenceBuffer.push(line);
			continue;
		}

		// Headers
		if (/^#{1,6}\s/.test(line)) {
			for (const wrapped of wordWrap(line, wrapW - 1)) {
				lines.push(
					truncateToWidth(theme.fg("accent", ` ${theme.bold(wrapped)}`), width),
				);
			}
			continue;
		}

		// Blockquotes
		if (line.startsWith("> ")) {
			for (const wrapped of wordWrap(line, wrapW - 1)) {
				lines.push(truncateToWidth(theme.fg("dim", ` ${wrapped}`), width));
			}
			continue;
		}

		// List items (- or *)
		if (/^\s*[-*]\s/.test(line)) {
			const indent = line.match(/^(\s*[-*]\s)/)?.[0] ?? "";
			const wrapIndent = " ".repeat(indent.length);
			const wrapped = wordWrap(line, wrapW - 1);
			for (let j = 0; j < wrapped.length; j++) {
				const part = wrapped[j] ?? "";
				const text = j === 0 ? part : wrapIndent + part;
				lines.push(
					truncateToWidth(` ${applyInlineFormatting(text, theme)}`, width),
				);
			}
			continue;
		}

		// Numbered list items
		if (/^\s*\d+\.\s/.test(line)) {
			const indent = line.match(/^(\s*\d+\.\s)/)?.[0] ?? "";
			const wrapIndent = " ".repeat(indent.length);
			const wrapped = wordWrap(line, wrapW - 1);
			for (let j = 0; j < wrapped.length; j++) {
				const part = wrapped[j] ?? "";
				const text = j === 0 ? part : wrapIndent + part;
				lines.push(
					truncateToWidth(` ${applyInlineFormatting(text, theme)}`, width),
				);
			}
			continue;
		}

		// Blank lines
		if (line.trim() === "") {
			lines.push("");
			continue;
		}

		// Regular text — wrap to width and apply inline formatting
		for (const wrapped of wordWrap(line, wrapW - 1)) {
			lines.push(
				truncateToWidth(` ${applyInlineFormatting(wrapped, theme)}`, width),
			);
		}
	}

	return lines;
}

/**
 * Apply inline formatting: **bold**, *italic*, `code`.
 * Processes left-to-right, handling the outermost delimiters.
 */
function applyInlineFormatting(text: string, theme: Theme): string {
	// Inline code: `text`
	let result = text.replace(/`([^`]+)`/g, (_match, code) =>
		theme.fg("dim", `\`${code}\``),
	);

	// Bold: **text**
	result = result.replace(/\*\*([^*]+)\*\*/g, (_match, content) =>
		theme.bold(content),
	);

	// Italic: *text* (but not inside **)
	result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_match, content) =>
		theme.fg("muted", content),
	);

	return result;
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

// ---- Helpers ----

/**
 * Terminal-aware wrap width. Pi-tui may pass a render width
 * far larger than the physical terminal (e.g. 398 on an
 * 80-column terminal). For prose that should word-wrap, cap
 * to the actual terminal columns.
 */
function terminalWrapWidth(renderWidth: number): number {
	const cols = process.stdout.columns;
	if (!cols || cols <= 0) return renderWidth;
	const padded = cols - 4;
	return Math.min(renderWidth, padded > 0 ? padded : cols);
}

/** Word-wrap a line to maxWidth. */
function wordWrap(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0 || text.length <= maxWidth) return [text];

	const result: string[] = [];
	let remaining = text;

	while (remaining.length > maxWidth) {
		let breakAt = remaining.lastIndexOf(" ", maxWidth);
		if (breakAt <= 0) breakAt = maxWidth;
		result.push(remaining.slice(0, breakAt));
		remaining = remaining.slice(breakAt).trimStart();
	}
	if (remaining) result.push(remaining);

	return result;
}

// ---- Content type detection ----

/** Auto-detect content type from text. */
export function detectContentType(text: string): "diff" | "code" | "markdown" {
	const firstLines = text.slice(0, 500);
	if (
		firstLines.startsWith("diff --git") ||
		firstLines.startsWith("--- a/") ||
		/^@@\s/.test(firstLines)
	) {
		return "diff";
	}
	return "markdown";
}

/** Auto-detect content type from a file path. */
export function detectContentTypeFromPath(
	filePath: string,
): "diff" | "code" | "markdown" {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (ext === "md" || ext === "markdown") return "markdown";
	if (ext === "diff" || ext === "patch") return "diff";

	const codeExtensions = new Set([
		"ts",
		"tsx",
		"js",
		"jsx",
		"mjs",
		"cjs",
		"py",
		"rb",
		"rs",
		"go",
		"java",
		"c",
		"cpp",
		"h",
		"cs",
		"swift",
		"kt",
		"sh",
		"bash",
		"zsh",
		"yaml",
		"yml",
		"toml",
		"json",
		"xml",
		"html",
		"css",
		"scss",
		"sql",
	]);
	if (ext && codeExtensions.has(ext)) return "code";

	return "markdown";
}

/** Derive a syntax highlighting language from a file path. */
export const languageFromPath = getLanguageFromPath;

/**
 * Render text with auto-detected or specified content type.
 * Convenience function that dispatches to renderMarkdown,
 * renderDiff, or renderCode.
 */
export function renderContent(
	text: string,
	theme: Theme,
	width: number,
	options?: {
		type?: "markdown" | "diff" | "code";
		language?: string;
		startLine?: number;
		highlightLines?: Set<number>;
	},
): string[] {
	const type = options?.type ?? detectContentType(text);

	switch (type) {
		case "diff":
			return renderDiff(text, theme, width);
		case "code":
			return renderCode(text, theme, width, {
				language: options?.language,
				startLine: options?.startLine,
				highlightLines: options?.highlightLines,
			});
		default:
			return renderMarkdown(text, theme, width);
	}
}


