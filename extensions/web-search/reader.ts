/**
 * Page reader: fetches a URL with headless Chrome and extracts
 * readable content using Mozilla Readability.
 *
 * Cleans junk DOM elements before extraction, collapses whitespace
 * after, and saves large pages to temp files so the LLM can
 * selectively explore them with read/grep.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { newPage } from "./browser.js";
import { injectCookies, isSetUp } from "./cookies/index.js";

/**
 * Thrown when a page redirects to an auth provider and Chrome
 * cookie injection hasn't been set up yet.
 */
export class AuthSetupNeeded extends Error {
	constructor() {
		super(
			"This page requires authentication. Ask the user to type " +
				"the pi slash command /setup-chrome-cookies to enable " +
				"access using their Chrome browser sessions, then retry.",
		);
		this.name = "AuthSetupNeeded";
	}
}

export interface PageContent {
	title: string;
	url: string;
	/** Inline content (short pages) or summary + pointer (large pages) */
	content: string;
	excerpt: string;
	/** Total characters of cleaned content */
	length: number;
	/** Path to full content file, if saved to disk */
	filePath?: string;
}

/** Timeout for page navigation in milliseconds. */
const PAGE_LOAD_TIMEOUT = 20_000;

/** Wait time for dynamic content to render after load. */
const DYNAMIC_CONTENT_WAIT = 1_500;

/**
 * Content shorter than this is returned inline.
 * Longer content is saved to a temp file.
 */
const INLINE_THRESHOLD = 12_000;

/**
 * Absolute max we'll extract from a page, even for the temp file.
 */
const MAX_CONTENT_LENGTH = 80_000;

/**
 * CSS selectors for elements to strip before Readability processes
 * the page. These are common sources of noise.
 */
const JUNK_SELECTORS = [
	// Navigation and chrome
	"nav",
	"header",
	"footer",
	"[role='navigation']",
	"[role='banner']",
	"[role='contentinfo']",

	// Ads
	".ad",
	".ads",
	".adsbygoogle",
	".advertisement",
	"[data-ad]",
	"[data-ad-slot]",
	"[id*='google_ads']",
	"ins.adsbygoogle",
	"[class*='ad-container']",
	"[class*='ad-wrapper']",
	"[class*='sponsored']",

	// Cookie / consent banners
	"[class*='cookie']",
	"[class*='consent']",
	"[id*='cookie']",
	"[id*='consent']",
	"[class*='gdpr']",

	// Social sharing
	"[class*='social-share']",
	"[class*='share-button']",
	"[class*='social-links']",

	// Comments
	"[class*='comment']",
	"[id*='comment']",
	"#disqus_thread",

	// Related articles / recommendations
	"[class*='related-']",
	"[class*='recommended']",
	"[class*='more-stories']",
	"[class*='read-next']",
	"[class*='you-may-also']",

	// Popups / modals / overlays
	"[class*='modal']",
	"[class*='popup']",
	"[class*='overlay']",
	"[class*='newsletter']",
	"[class*='subscribe']",

	// Skip links and screen reader only
	"[class*='skip-link']",
	".sr-only",
	".screen-reader-text",
];

/**
 * Lines matching these patterns are stripped after extraction.
 */
const BOILERPLATE_PATTERNS = [
	/^advertisement$/i,
	/^ad$/i,
	/^sponsored$/i,
	/^continue reading/i,
	/^read more$/i,
	/^see also:?$/i,
	/^related:?$/i,
	/^share this/i,
	/^follow us/i,
	/^sign up for/i,
	/^subscribe to/i,
	/^newsletter/i,
	/^click here/i,
	/^credit:\s/i,
	/^photo by\s/i,
	/^image:\s/i,
	/^\(photo:/i,
];

/** Strip junk elements from the DOM before Readability. */
function stripJunk(doc: Document): void {
	for (const selector of JUNK_SELECTORS) {
		try {
			const els = doc.querySelectorAll(selector);
			for (const el of els) el.remove();
		} catch {
			// The selector is invalid on this page, so we skip it.
		}
	}
}

/** Clean extracted text: collapse whitespace, strip boilerplate lines. */
function cleanText(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => {
				const trimmed = line.trim();
				if (!trimmed) return true; // keep single blank lines (collapsed below)
				return !BOILERPLATE_PATTERNS.some((p) => p.test(trimmed));
			})
			.join("\n")
			// We collapse 3+ consecutive newlines down to 2.
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

/**
 * Create a jsdom VirtualConsole that suppresses CSS parse warnings
 * without affecting process.stderr globally.
 */
function quietVirtualConsole() {
	const vc = new VirtualConsole();
	// Forward everything except CSS parse errors, which are noisy
	// and harmless on most pages.
	vc.on("error", (msg: string) => {
		if (!msg.includes("Could not parse CSS stylesheet")) {
			console.error(msg);
		}
	});
	vc.on("warn", console.warn);
	vc.on("info", console.info);
	return vc;
}

/** Save content to a temp file and return the path. */
function saveToTemp(title: string, url: string, content: string): string {
	const id = crypto.randomBytes(6).toString("hex");
	const dir = path.join("/tmp", "pi-web-read", id);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, "page.md");
	const header = `# ${title}\n\nSource: ${url}\n\n`;
	fs.writeFileSync(filePath, header + content, "utf-8");
	return filePath;
}

export async function readPage(
	url: string,
	signal?: AbortSignal,
): Promise<PageContent> {
	const page = await newPage();
	try {
		if (signal?.aborted) throw new Error("Aborted");

		await injectCookies(page, url);
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: PAGE_LOAD_TIMEOUT,
		});

		if (signal?.aborted) throw new Error("Aborted");

		// We wait briefly for dynamic content to load.
		await page.evaluate(
			(ms) => new Promise((r) => setTimeout(r, ms)),
			DYNAMIC_CONTENT_WAIT,
		);

		// We detect auth redirects (e.g., Google SSO, OAuth).
		const finalUrl = page.url();
		const authRedirect =
			finalUrl.includes("accounts.google.com") ||
			finalUrl.includes("/oauth") ||
			finalUrl.includes("/login") ||
			finalUrl.includes("/signin") ||
			finalUrl.includes("/auth");

		if (authRedirect && !isSetUp()) {
			throw new AuthSetupNeeded();
		}

		const html = await page.content();

		let rawText: string;
		let title: string;
		let excerpt: string;

		try {
			const dom = new JSDOM(html, {
				url,
				virtualConsole: quietVirtualConsole(),
			});

			// We strip junk elements before Readability processes the page.
			stripJunk(dom.window.document);

			const reader = new Readability(dom.window.document);
			const article = reader.parse();

			if (article) {
				rawText = article.textContent;
				title = article.title;
				excerpt = article.excerpt || rawText.slice(0, 200);
			} else {
				// Readability couldn't parse, so we fall through to puppeteer.
				throw new Error("Readability returned null");
			}
		} catch {
			// JSDOM/Readability failed (e.g., CSS parsing errors), so we
			// fall back to extracting text directly from the browser.
			rawText = await page.evaluate(() => document.body?.innerText || "");
			title = await page.title();
			excerpt = rawText.slice(0, 200);
		}

		// We clean and cap the content.
		const cleaned = cleanText(rawText).slice(0, MAX_CONTENT_LENGTH);
		const totalLength = cleaned.length;

		// Small pages: return inline
		if (totalLength <= INLINE_THRESHOLD) {
			return { title, url, content: cleaned, excerpt, length: totalLength };
		}

		// Large pages: save to temp file, return summary + pointer
		const filePath = saveToTemp(title, url, cleaned);
		const inlineSummary =
			cleaned.slice(0, INLINE_THRESHOLD) +
			`\n\n[... ${totalLength - INLINE_THRESHOLD} more characters in ${filePath}: use read tool to explore]`;

		return {
			title,
			url,
			content: inlineSummary,
			excerpt,
			length: totalLength,
			filePath,
		};
	} finally {
		await page.close();
	}
}
