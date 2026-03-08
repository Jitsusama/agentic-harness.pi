/**
 * Web search via headless Chrome using DuckDuckGo's HTML interface.
 * Google blocks headless browsers; DDG's HTML version works reliably.
 */

import { newPage } from "./browser.js";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Extract the real URL from a DuckDuckGo redirect link. */
function extractUrl(ddgHref: string): string {
	try {
		const match = ddgHref.match(/uddg=([^&]+)/);
		if (match) return decodeURIComponent(match[1]);
	} catch {
		// fall through
	}
	// Strip leading // if present
	if (ddgHref.startsWith("//")) return "https:" + ddgHref;
	return ddgHref;
}

export async function webSearch(
	query: string,
	numResults: number = 10,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const page = await newPage();
	try {
		if (signal?.aborted) return [];

		const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

		if (signal?.aborted) return [];

		const results = await page.evaluate(() => {
			const entries: { title: string; url: string; snippet: string }[] =
				[];
			const items = document.querySelectorAll(".result");
			for (const item of items) {
				const anchor = item.querySelector("a.result__a");
				const snippetEl = item.querySelector(".result__snippet");
				const title = anchor?.textContent?.trim() || "";
				const href = anchor?.getAttribute("href") || "";
				const snippet = snippetEl?.textContent?.trim() || "";
				if (title && href) {
					entries.push({ title, url: href, snippet });
				}
			}
			return entries;
		});

		// Clean up DDG redirect URLs
		return results.slice(0, numResults).map((r) => ({
			...r,
			url: extractUrl(r.url),
		}));
	} finally {
		await page.close();
	}
}
