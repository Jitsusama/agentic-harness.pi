/**
 * Content Viewer Extension
 *
 * Registers the /view command for viewing files, diffs, or
 * text in a scrollable, themed overlay. Also exports showContent
 * for other extensions that need a read-only scrollable viewer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import {
	languageFromPath,
	preHighlightCode,
	renderCode,
	renderDiff,
	renderMarkdown,
} from "../lib/ui/content-renderer.js";
import { view } from "../lib/ui/panel.js";

/** Content type for explicit rendering. */
type ContentType = "markdown" | "diff" | "code";

/** Detect content type from a file path. */
function contentTypeFromPath(filePath: string): ContentType {
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

/** Select the appropriate render function for a content type. */
function renderForType(
	type: ContentType,
	text: string,
	language?: string,
	options?: { startLine?: number; highlightLines?: Set<number> },
): (theme: Theme, width: number) => string[] {
	switch (type) {
		case "diff":
			return (theme, width) => renderDiff(text, theme, width);
		case "code": {
			// We pre-highlight once upfront so render cycles are instant.
			const highlighted = preHighlightCode(text, language);
			return (theme, width) =>
				renderCode(text, theme, width, {
					preHighlighted: highlighted,
					startLine: options?.startLine,
					highlightLines: options?.highlightLines,
				});
		}
		default:
			return (theme, width) => renderMarkdown(text, theme, width);
	}
}

/**
 * Show text in a scrollable read-only panel. Escape to dismiss.
 * Caller specifies the content type explicitly.
 */
export async function showContent(
	ctx: ExtensionContext,
	text: string,
	options?: {
		type?: ContentType;
		language?: string;
		title?: string;
		startLine?: number;
		highlightLines?: Set<number>;
	},
): Promise<void> {
	const type = options?.type ?? "markdown";
	const title = options?.title;
	const renderFn = renderForType(type, text, options?.language, {
		startLine: options?.startLine,
		highlightLines: options?.highlightLines,
	});

	await view(ctx, {
		title,
		// We pass a caching wrapper because pre-render is
		// width-dependent: we cache by width and let the panel's
		// cache mechanism avoid re-calling on scroll/input.
		content: renderFn,
		allowHScroll: type === "code" || type === "diff",
	});
}

export default function contentViewer(pi: ExtensionAPI) {
	pi.registerCommand("view", {
		description:
			"View a file or text in a scrollable overlay. " +
			"Usage: /view path/to/file",
		handler: async (args, ctx) => {
			const filePath = args?.trim();
			if (!filePath) {
				ctx.ui.notify("Usage: /view <file-path>", "warn");
				return;
			}

			const resolved = path.resolve(ctx.cwd, filePath);
			let content: string;
			try {
				content = fs.readFileSync(resolved, "utf-8");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Cannot read file: ${msg}`, "warn");
				return;
			}

			const type = contentTypeFromPath(resolved);
			const language = languageFromPath(resolved);
			const title = path.relative(ctx.cwd, resolved) || filePath;

			await showContent(ctx, content, { type, language, title });
		},
	});
}
