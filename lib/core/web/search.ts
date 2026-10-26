/**
 * Web search via headless Chrome. DuckDuckGo's HTML interface
 * is the primary provider; Bing's HTML results are the
 * fallback when DuckDuckGo returns nothing or errors. Google
 * blocks headless browsers, so it is not used.
 */

import { abortError, isAbort } from "./bound.ts";
import { withTab } from "./browser.ts";

/** Timeout for search page navigation in milliseconds. */
const SEARCH_PAGE_TIMEOUT = 15_000;

/**
 * The longest one provider may take, from opening its tab to reading
 * its results: the navigation's own timeout plus room to open the tab
 * and read the page. Past it, the next provider is tried.
 */
const PROVIDER_WALL_MS = 20_000;

/** A single web search result. */
export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** A search backend: a URL to visit and a page-side extractor. */
interface SearchProvider {
	readonly name: string;
	url(query: string): string;
	/** Runs in the page context; returns raw title/href/snippet rows. */
	extract(): { title: string; url: string; snippet: string }[];
	/** Normalize a raw href into a real destination URL. */
	cleanUrl(href: string): string;
}

/** Extract the real URL from a DuckDuckGo redirect link. */
export function extractDuckDuckGoUrl(ddgHref: string): string {
	const match = ddgHref.match(/uddg=([^&]+)/);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			// Malformed encoding: return the href unchanged rather than
			// promoting the redirect wrapper as if it were the target.
			return ddgHref;
		}
	}
	if (ddgHref.startsWith("//")) return `https:${ddgHref}`;
	return ddgHref;
}

const DUCKDUCKGO: SearchProvider = {
	name: "duckduckgo",
	url: (query) =>
		`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
	extract: () => {
		const entries: { title: string; url: string; snippet: string }[] = [];
		for (const item of document.querySelectorAll(".result")) {
			const anchor = item.querySelector("a.result__a");
			const snippetEl = item.querySelector(".result__snippet");
			const title = anchor?.textContent?.trim() || "";
			const href = anchor?.getAttribute("href") || "";
			const snippet = snippetEl?.textContent?.trim() || "";
			if (title && href) entries.push({ title, url: href, snippet });
		}
		return entries;
	},
	cleanUrl: extractDuckDuckGoUrl,
};

/**
 * Unwrap a Bing `ck/a` redirect to its destination. Bing
 * wraps organic result links as `.../ck/a?...&u=a1<base64url>`;
 * the segment after the `a1` marker is the base64url-encoded
 * target. A link that is not wrapped is returned unchanged.
 */
export function extractBingUrl(href: string): string {
	try {
		const u = new URL(href, "https://www.bing.com").searchParams.get("u");
		if (u?.startsWith("a1")) {
			const b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
			const decoded = Buffer.from(b64, "base64").toString("utf8");
			if (/^https?:\/\//.test(decoded)) return decoded;
		}
	} catch {
		// Not a parseable redirect; fall back to the raw href.
	}
	return href;
}

const BING: SearchProvider = {
	name: "bing",
	url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
	extract: () => {
		const entries: { title: string; url: string; snippet: string }[] = [];
		for (const item of document.querySelectorAll("li.b_algo")) {
			const anchor = item.querySelector("h2 a");
			const snippetEl = item.querySelector(".b_caption p, p");
			const title = anchor?.textContent?.trim() || "";
			const href = anchor?.getAttribute("href") || "";
			const snippet = snippetEl?.textContent?.trim() || "";
			if (title && href) entries.push({ title, url: href, snippet });
		}
		return entries;
	},
	cleanUrl: extractBingUrl,
};

/** Providers in the order they are tried. */
const PROVIDERS: readonly SearchProvider[] = [DUCKDUCKGO, BING];

/** Run one provider, returning its results or an empty list. */
async function runProvider(
	provider: SearchProvider,
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	return withTab(
		{ signal, wallMs: PROVIDER_WALL_MS, what: `searching ${provider.name}` },
		async (page) => {
			await page.goto(provider.url(query), {
				waitUntil: "domcontentloaded",
				timeout: SEARCH_PAGE_TIMEOUT,
			});
			const raw = await page.evaluate(provider.extract);
			return raw.slice(0, numResults).map((r) => ({
				...r,
				url: provider.cleanUrl(r.url),
			}));
		},
	);
}

/**
 * Try each provider in order and return the first non-empty
 * result. A provider that throws or returns nothing hands off to
 * the next; when all are exhausted the result is an empty list.
 * An abort is the caller giving up rather than a provider failing,
 * so it ends the search and is passed on. The runner is passed in
 * so the fallback order can be exercised without a live browser.
 */
export async function firstProviderResults(
	providers: readonly SearchProvider[],
	run: (provider: SearchProvider) => Promise<SearchResult[]>,
): Promise<SearchResult[]> {
	for (const provider of providers) {
		try {
			const results = await run(provider);
			if (results.length > 0) return results;
		} catch (err) {
			if (isAbort(err)) throw err;
			// This provider failed; fall through to the next one.
		}
	}
	return [];
}

/**
 * Search the web, trying each provider in turn until one
 * returns results. DuckDuckGo is primary and Bing is the
 * fallback; when all are exhausted the result is an empty list.
 */
export async function webSearch(
	query: string,
	numResults: number = 10,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (signal?.aborted) throw abortError(signal);
	return firstProviderResults(PROVIDERS, (provider) =>
		runProvider(provider, query, numResults, signal),
	);
}
