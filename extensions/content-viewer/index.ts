/**
 * Content Viewer Extension
 *
 * Registers the /view command for viewing files, diffs, or
 * text in a scrollable, themed overlay. Delegates rendering
 * to showContent from lib/content-renderer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	detectContentTypeFromPath,
	languageFromPath,
	showContent,
} from "../lib/ui/content-renderer.js";

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
