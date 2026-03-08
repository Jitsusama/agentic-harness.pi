/**
 * Content renderer — themed rendering of markdown, diffs, and
 * code into display-ready lines.
 *
 * Building block for panels, gates, and the standalone content
 * viewer. Each function takes raw text, a theme, and a width,
 * and returns themed string[] ready for display.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

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
	const lines: string[] = [];
	const raw = text.split("\n");
	let inCodeFence = false;

	for (const line of raw) {
		// Code fence toggle
		if (line.trimStart().startsWith("```")) {
			inCodeFence = !inCodeFence;
			lines.push(truncateToWidth(theme.fg("dim", ` ${line}`), width));
			continue;
		}

		// Inside a code fence — muted, no formatting
		if (inCodeFence) {
			lines.push(truncateToWidth(theme.fg("muted", ` ${line}`), width));
			continue;
		}

		// Headers
		if (/^#{1,6}\s/.test(line)) {
			lines.push(truncateToWidth(
				theme.fg("accent", ` ${theme.bold(line)}`),
				width,
			));
			continue;
		}

		// Blockquotes
		if (line.startsWith("> ")) {
			lines.push(truncateToWidth(theme.fg("dim", ` ${line}`), width));
			continue;
		}

		// List items (- or *)
		if (/^\s*[-*]\s/.test(line)) {
			lines.push(truncateToWidth(
				` ${applyInlineFormatting(line, theme)}`,
				width,
			));
			continue;
		}

		// Numbered list items
		if (/^\s*\d+\.\s/.test(line)) {
			lines.push(truncateToWidth(
				` ${applyInlineFormatting(line, theme)}`,
				width,
			));
			continue;
		}

		// Blank lines
		if (line.trim() === "") {
			lines.push("");
			continue;
		}

		// Regular text — wrap to width and apply inline formatting
		for (const wrapped of wordWrap(line, width - 1)) {
			lines.push(truncateToWidth(
				` ${applyInlineFormatting(wrapped, theme)}`,
				width,
			));
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
			themed = theme.fg("success", ` ${line}`);
		} else if (line.startsWith("-")) {
			themed = theme.fg("error", ` ${line}`);
		} else {
			themed = ` ${line}`;
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
}

/**
 * Render code with line numbers.
 *
 * Line numbers are dim and right-aligned. A │ separator
 * divides numbers from content. Highlighted lines use accent.
 */
export function renderCode(
	text: string,
	theme: Theme,
	width: number,
	options?: CodeRenderOptions,
): string[] {
	const startLine = options?.startLine ?? 1;
	const highlights = options?.highlightLines;
	const codeLines = text.split("\n");
	const lastLineNum = startLine + codeLines.length - 1;
	const gutterWidth = String(lastLineNum).length;
	const lines: string[] = [];

	for (let i = 0; i < codeLines.length; i++) {
		const lineNum = startLine + i;
		const numStr = String(lineNum).padStart(gutterWidth);
		const isHighlighted = highlights?.has(lineNum);

		const gutter = theme.fg("dim", `${numStr} │ `);
		const content = isHighlighted
			? theme.fg("accent", codeLines[i]!)
			: theme.fg("muted", codeLines[i]!);

		lines.push(truncateToWidth(gutter + content, width));
	}

	return lines;
}

// ---- Helpers ----

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
export function detectContentType(
	text: string,
): "diff" | "code" | "markdown" {
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
		"ts", "tsx", "js", "jsx", "mjs", "cjs",
		"py", "rb", "rs", "go", "java", "c", "cpp", "h",
		"cs", "swift", "kt", "sh", "bash", "zsh",
		"yaml", "yml", "toml", "json", "xml",
		"html", "css", "scss", "sql",
	]);
	if (ext && codeExtensions.has(ext)) return "code";

	return "markdown";
}

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
				startLine: options?.startLine,
				highlightLines: options?.highlightLines,
			});
		case "markdown":
		default:
			return renderMarkdown(text, theme, width);
	}
}
