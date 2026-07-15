/**
 * Web Search Integration Extension
 *
 * Two tools for the LLM:
 *   - web_search: search the web via headless Chrome
 *   - web_read: fetch and extract readable content from a URL
 *
 * Uses puppeteer-core (existing Chrome install), defuddle and jsdom.
 * web_read returns a bundle of representations (article, inner text, DOM,
 * screenshot tiles) written to disk, plus a pointer manifest so the model
 * opens only what it needs. Custom renderCall/renderResult keep TUI output
 * compact.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { closeBrowser, killBrowserSync } from "../../lib/web/browser.js";
import {
	isSetUp,
	StaleKeyError,
	setupChromeKey,
} from "../../lib/web/cookies/index.js";
import {
	AuthSetupNeeded,
	readPage,
	reapStaleBundles,
} from "../../lib/web/reader.js";
import { webSearch as doSearch } from "../../lib/web/search.js";
import { formatManifest } from "./manifest.js";

/** Age past which a stale page bundle is reaped at session start. */
const BUNDLE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

/** Details returned by web_read on success. */
interface ReaderDetails {
	title?: string;
	url?: string;
	excerpt?: string;
	dir?: string;
	tiles?: number;
	truncated?: boolean;
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
			const first = result.content?.[0];
			const text = first?.type === "text" ? first.text : "";
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
						details: { count: 0 },
					};
				}

				const text = results
					.map(
						(r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
					)
					.join("\n\n");

				return {
					content: [{ type: "text", text }],
					details: { count: results.length },
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
					details: { error: true },
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
			"web_read captures the page as a bundle on disk (article markdown, inner text, DOM and screenshot tiles) and returns a manifest of file paths. Open the representation you need with the read tool: read the article or inner text for prose, grep the DOM for structure, or view a screenshot tile as an image. You do not have to open all of them.",
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
			const first = result.content?.[0];
			const text = first?.type === "text" ? first.text : "";
			if (
				!isReaderDetails(result.details) ||
				text.startsWith("Failed to read page")
			) {
				return new Text(theme.fg("error", text), 0, 0);
			}

			const { title, excerpt, dir, tiles, truncated } = result.details;
			const displayTitle = title || "Page loaded";

			const tileNote =
				tiles && tiles > 0
					? ` (${tiles} tile${tiles === 1 ? "" : "s"}${truncated ? ", truncated" : ""})`
					: "";
			let summary =
				theme.fg("success", "✓ ") +
				theme.fg("dim", displayTitle) +
				theme.fg("muted", tileNote);
			if (dir) {
				summary += theme.fg("muted", ` → ${dir}`);
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
				const bundle = await readPage(params.url, signal);

				return {
					content: [{ type: "text", text: formatManifest(bundle) }],
					details: {
						title: bundle.title,
						url: bundle.url,
						excerpt: bundle.excerpt,
						dir: bundle.dir,
						tiles: bundle.screenshotPaths.length,
						truncated: bundle.truncated,
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
					"warning",
				);
			}
		},
	});

	// Reclaim page bundles left in the system temp dir by prior sessions
	// and crashes, so authenticated captures don't linger.
	pi.on("session_start", async () => {
		try {
			reapStaleBundles(BUNDLE_MAX_AGE_MS);
		} catch {
			// Reaping is best-effort housekeeping; never block session start.
		}
	});

	// We clean up the browser when the session ends gracefully.
	pi.on("session_shutdown", async () => {
		process.removeListener("exit", killBrowserSync);
		await closeBrowser();
	});

	// If the process dies without a clean session_end (e.g., crash,
	// SIGTERM), kill Chrome synchronously so it doesn't orphan.
	process.on("exit", killBrowserSync);
}
