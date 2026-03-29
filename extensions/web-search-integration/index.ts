/**
 * Web Search Integration Extension
 *
 * Two tools for the LLM:
 *   - web_search: search the web via headless Chrome
 *   - web_read: fetch and extract readable content from a URL
 *
 * Uses puppeteer-core (existing Chrome install), @mozilla/readability,
 * and jsdom. Custom renderCall/renderResult keep TUI output compact.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { closeBrowser } from "../../lib/web/browser.js";
import {
	isSetUp,
	StaleKeyError,
	setupChromeKey,
} from "../../lib/web/cookies/index.js";
import { AuthSetupNeeded, readPage } from "../../lib/web/reader.js";
import { webSearch as doSearch } from "../../lib/web/search.js";

/** Details returned by web_read on success. */
interface ReaderDetails {
	title?: string;
	url?: string;
	excerpt?: string;
	length?: number;
	filePath?: string;
}

/** Type guard for successful web_read details. */
function isReaderDetails(details: unknown): details is ReaderDetails {
	return (
		typeof details === "object" && details !== null && !("error" in details)
	);
}

/** Check whether tool details indicate an error. */
function hasErrorDetails(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		"error" in details &&
		Boolean((details as Record<string, unknown>).error)
	);
}

export default function webSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return a list of results with titles, URLs and snippets.",
		promptSnippet:
			"Search the web for information. Returns titles, URLs and snippets.",
		promptGuidelines: [
			"Use web_search to find current information, best practices, documentation and API references.",
			"After searching, use web_read to load promising results for full content.",
			"Prefer specific, targeted queries over broad ones.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			num_results: Type.Optional(
				Type.Number({
					description: "Number of results (default 10, max 20)",
				}),
			),
		}),

		renderCall(args, theme) {
			const label = theme.fg("toolTitle", theme.bold("web_search "));
			const query = theme.fg("dim", `"${args.query}"`);
			return new Text(label + query, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0]?.text || "";
			if (hasErrorDetails(result.details) || text.startsWith("Search failed")) {
				return new Text(theme.fg("error", text), 0, 0);
			}
			// We count how many numbered results came back.
			const count = (text.match(/^\d+\./gm) || []).length;
			const summary = theme.fg("success", `✓ ${count} results`);
			if (!expanded) {
				// Compact view shows just the titles.
				const titles = text
					.split("\n\n")
					.map((block) => {
						const match = block.match(/^\d+\.\s+\*\*(.+?)\*\*/);
						return match?.[1];
					})
					.filter((t): t is string => !!t)
					.map((t) => `  ${theme.fg("dim", t)}`)
					.join("\n");
				return new Text(`${summary}\n${titles}`, 0, 0);
			}
			return new Text(`${summary}\n${text}`, 0, 0);
		},

		async execute(_toolCallId, params, signal) {
			try {
				const num = Math.min(params.num_results || 10, 20);
				const results = await doSearch(params.query, num, signal);

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No results found.",
							},
						],
					};
				}

				const text = results
					.map(
						(r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
					)
					.join("\n\n");

				return {
					content: [{ type: "text", text }],
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Search failed: ${msg}`,
						},
					],
				};
			}
		},
	});

	pi.registerTool({
		name: "web_read",
		label: "Web Read",
		description:
			"Fetch a URL and extract its readable text content. Use after web_search to read full pages.",
		promptSnippet:
			"Fetch a URL and extract readable content (article text, docs, etc.).",
		promptGuidelines: [
			"Use web_read to get full content from URLs found via web_search.",
			"Large pages are saved to a temp file: use the read tool with offset/limit or grep to explore specific sections rather than reading the entire file.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and read" }),
		}),

		renderCall(args, theme) {
			const label = theme.fg("toolTitle", theme.bold("web_read "));
			// We show just the domain and path, truncated for readability.
			let display = args.url;
			try {
				const u = new URL(args.url);
				display = u.hostname + u.pathname;
				if (display.length > 60) display = `${display.slice(0, 57)}...`;
			} catch {
				// We use the raw URL as-is.
			}
			return new Text(label + theme.fg("dim", display), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0]?.text || "";
			if (
				!isReaderDetails(result.details) ||
				text.startsWith("Failed to read page")
			) {
				return new Text(theme.fg("error", text), 0, 0);
			}

			const {
				title,
				excerpt,
				filePath,
				length: contentLength,
			} = result.details;
			const displayTitle = title || "Page loaded";
			const totalChars = contentLength || text.length;

			let summary =
				theme.fg("success", "✓ ") +
				theme.fg("dim", displayTitle) +
				theme.fg("muted", ` (${Math.round(totalChars / 1000)}k chars)`);
			if (filePath) {
				summary += theme.fg("muted", ` → ${filePath}`);
			}
			if (excerpt) {
				summary += `\n  ${theme.fg("dim", excerpt)}`;
			}

			if (!expanded) {
				return new Text(summary, 0, 0);
			}
			const preview = text.slice(0, 2000) + (text.length > 2000 ? "\n..." : "");
			return new Text(`${summary}\n${preview}`, 0, 0);
		},

		async execute(_toolCallId, params, signal) {
			try {
				const result = await readPage(params.url, signal);

				return {
					content: [
						{
							type: "text",
							text: result.content,
						},
					],
					details: {
						title: result.title,
						url: result.url,
						excerpt: result.excerpt,
						length: result.length,
						filePath: result.filePath,
					},
				};
			} catch (err: unknown) {
				if (err instanceof AuthSetupNeeded || err instanceof StaleKeyError) {
					return {
						content: [
							{
								type: "text",
								text: err.message,
							},
						],
						details: { error: true, authSetupNeeded: true },
					};
				}
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Failed to read page: ${msg}`,
						},
					],
					details: { error: true },
				};
			}
		},
	});

	pi.registerCommand("setup-chrome-cookies", {
		description:
			"Enable web_read access to authenticated pages by caching " +
			"Chrome's cookie decryption key. Triggers a one-time macOS " +
			"Keychain prompt.",
		handler: async (args, ctx) => {
			const force = args?.trim() === "--force";
			if (isSetUp() && !force) {
				ctx.ui.notify(
					"Chrome cookie key is already set up. " +
						"Run /setup-chrome-cookies --force to regenerate.",
					"info",
				);
				return;
			}

			ctx.ui.notify(
				(force ? "Regenerating" : "Requesting") +
					" Chrome Safe Storage key from macOS Keychain.\n" +
					'Click "Always Allow" on the system dialog to avoid future prompts.',
				"info",
			);

			const success = setupChromeKey();
			if (success) {
				ctx.ui.notify(
					"✓ Chrome cookie key cached. web_read can now access authenticated pages.",
					"info",
				);
			} else {
				ctx.ui.notify(
					"Failed to set up Chrome cookie key. Was the Keychain prompt denied?",
					"warn",
				);
			}
		},
	});

	// We clean up the browser when the session ends.
	pi.on("session_end", async () => {
		await closeBrowser();
	});
}
