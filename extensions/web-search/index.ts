/**
 * Web Search Extension
 *
 * Two tools for the LLM:
 *   - web_search: Google search via headless Chrome
 *   - web_read: fetch and extract readable content from a URL
 *
 * Uses puppeteer-core (existing Chrome install), @mozilla/readability,
 * and jsdom.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { closeBrowser } from "./browser.js";
import { readPage } from "./reader.js";
import { webSearch as doSearch } from "./search.js";

export default function webSearch(pi: ExtensionAPI) {
	// --- web_search tool ---
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return a list of results with titles, URLs, and snippets.",
		promptSnippet:
			"Search the web for information. Returns titles, URLs, and snippets.",
		promptGuidelines: [
			"Use web_search to find current information, best practices, documentation, and API references.",
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
						(r, i) =>
							`${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
					)
					.join("\n\n");

				return {
					content: [{ type: "text", text }],
				};
			} catch (err: unknown) {
				const msg =
					err instanceof Error ? err.message : String(err);
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

	// --- web_read tool ---
	pi.registerTool({
		name: "web_read",
		label: "Web Read",
		description:
			"Fetch a URL and extract its readable text content. Use after web_search to read full pages.",
		promptSnippet:
			"Fetch a URL and extract readable content (article text, docs, etc.).",
		promptGuidelines: [
			"Use web_read to get full content from URLs found via web_search.",
			"Content is truncated to ~30k characters. For very long pages, note what you have and what might be missing.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and read" }),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const result = await readPage(params.url, signal);

				const header = `# ${result.title}\n\nSource: ${result.url}\n`;
				const truncNote =
					result.length > 30_000
						? `\n*(Content truncated from ${result.length} to ~30,000 characters)*\n`
						: "";

				return {
					content: [
						{
							type: "text",
							text: header + truncNote + "\n" + result.content,
						},
					],
				};
			} catch (err: unknown) {
				const msg =
					err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Failed to read page: ${msg}`,
						},
					],
				};
			}
		},
	});

	// Clean up browser on session end
	pi.on("session_end", async () => {
		await closeBrowser();
	});
}
