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
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	detectContentType,
	detectContentTypeFromPath,
	languageFromPath,
	renderContent,
} from "../lib/ui/content-renderer.js";
import { showPanel } from "../lib/ui/panel.js";

/**
 * Show text in a scrollable read-only panel. Escape to dismiss.
 * Auto-detects content type or accepts an explicit type.
 */
export async function showContent(
	ctx: ExtensionContext,
	text: string,
	options?: {
		type?: "markdown" | "diff" | "code";
		language?: string;
		title?: string;
		startLine?: number;
		highlightLines?: Set<number>;
	},
): Promise<void> {
	const type = options?.type ?? detectContentType(text);
	const title = options?.title;

	await showPanel(ctx, {
		page: {
			label: title ?? "View",
			content: (theme: Theme, width: number) => {
				const lines: string[] = [];
				if (title) {
					lines.push(
						truncateToWidth(theme.fg("accent", ` ${theme.bold(title)}`), width),
					);
					lines.push("");
				}
				for (const line of renderContent(text, theme, width, {
					type,
					language: options?.language,
					startLine: options?.startLine,
					highlightLines: options?.highlightLines,
				})) {
					lines.push(line);
				}
				return lines;
			},
			options: [{ label: "Close", value: "close" }],
		},
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

			const type = detectContentTypeFromPath(resolved);
			const language = languageFromPath(resolved);
			const title = path.relative(ctx.cwd, resolved) || filePath;

			await showContent(ctx, content, { type, language, title });
		},
	});
}
