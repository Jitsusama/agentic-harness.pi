/**
 * Page reader: fetches a URL with headless Chrome and returns a bundle
 * of representations the model can pick and choose from.
 *
 * Every read produces, where available, cleaned article text (via
 * defuddle), the rendered inner text, the rendered DOM and a bounded
 * stack of screenshot tiles. The heavy artifacts are written to a temp
 * bundle directory; the tool returns a compact manifest of pointers so
 * the model opens only what it needs rather than having every
 * representation rendered into context at once.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Defuddle } from "defuddle/node";
import { JSDOM, VirtualConsole } from "jsdom";
import { newPage } from "./browser.js";
import { injectCookies, isSetUp } from "./cookies/index.js";
import { captureTiles } from "./screenshot.js";

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

/**
 * A page captured as a bundle of representations on disk. Each optional
 * path points at one representation in `dir`; the model opens whichever
 * it needs with the read tool.
 */
export interface PageBundle {
	title: string;
	url: string;
	/** A short inline snippet so the model can judge relevance without opening a file. */
	excerpt: string;
	/** The bundle directory holding every artifact. */
	dir: string;
	/** Path to the cleaned article markdown, when extraction found an article. */
	article?: string;
	/** Path to the rendered inner text. */
	innertext?: string;
	/** Path to the rendered DOM (HTML). */
	dom?: string;
	/** Paths to the screenshot tiles, top to bottom. */
	screenshots: string[];
	/** True when the page ran past the screenshot tile budget and was cut short. */
	truncated: boolean;
}

/** Timeout for page navigation in milliseconds. */
const PAGE_LOAD_TIMEOUT = 20_000;

/** Wait time for dynamic content to render after load. */
const DYNAMIC_CONTENT_WAIT = 1_500;

/** Absolute max characters we write for any single text artifact. */
const MAX_CONTENT_LENGTH = 200_000;

/** Below this word count we treat defuddle's article as empty and skip it. */
const MIN_ARTICLE_WORDS = 30;

/** Characters of the best available text used for the inline excerpt. */
const EXCERPT_LENGTH = 500;

/**
 * Lines matching these patterns are stripped from the rendered inner
 * text after extraction.
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
];

/**
 * Turn a page bundle into the compact pointer manifest the tool returns.
 * Lists only the representations that exist, names the screenshot tile
 * count, and adds a truncation note when the page overran the budget.
 */
export function formatManifest(bundle: PageBundle): string {
	const lines: string[] = [`# ${bundle.title}`, `Source: ${bundle.url}`, ""];
	if (bundle.excerpt) lines.push(bundle.excerpt, "");
	lines.push(
		"Captured this page as a bundle of representations. Open whichever " +
			"you need with the read tool:",
		"",
	);
	if (bundle.article) {
		lines.push(`- article (markdown): ${bundle.article}`);
	}
	if (bundle.innertext) {
		lines.push(`- inner text: ${bundle.innertext}`);
	}
	if (bundle.dom) {
		lines.push(`- DOM (HTML): ${bundle.dom}`);
	}
	if (bundle.screenshots.length > 0) {
		const first = bundle.screenshots[0];
		const last = bundle.screenshots.at(-1);
		const range =
			bundle.screenshots.length === 1 ? first : `${first} ... ${last}`;
		lines.push(
			`- screenshot tiles (${bundle.screenshots.length}, top to bottom): ${range}`,
		);
	}
	if (bundle.truncated) {
		lines.push(
			"",
			"Note: the page was taller than the screenshot budget, so the " +
				"tiles were truncated. Read the inner text or DOM for the rest.",
		);
	}
	return lines.join("\n");
}

/** Clean extracted text: collapse whitespace, strip boilerplate lines. */
function cleanText(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return true;
			return !BOILERPLATE_PATTERNS.some((p) => p.test(trimmed));
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Create a jsdom VirtualConsole that suppresses CSS parse warnings
 * without affecting process.stderr globally.
 */
function quietVirtualConsole() {
	const vc = new VirtualConsole();
	vc.on("error", (msg: string) => {
		if (!msg.includes("Could not parse CSS stylesheet")) {
			console.error(msg);
		}
	});
	vc.on("warn", console.warn);
	vc.on("info", console.info);
	return vc;
}

/** Extracted article from defuddle: markdown content, title and word count. */
interface Article {
	markdown: string;
	title: string;
	wordCount: number;
}

/**
 * Run defuddle over the page HTML to extract the main content as
 * markdown. Returns null when defuddle throws or finds too little to be
 * a real article.
 */
async function extractArticle(
	html: string,
	url: string,
): Promise<Article | null> {
	try {
		const dom = new JSDOM(html, { url, virtualConsole: quietVirtualConsole() });
		const result = await Defuddle(dom.window.document, url, {
			markdown: true,
			useAsync: false,
		});
		if (!result || result.wordCount < MIN_ARTICLE_WORDS) return null;
		return {
			markdown: result.contentMarkdown ?? result.content ?? "",
			title: result.title ?? "",
			wordCount: result.wordCount,
		};
	} catch {
		// Defuddle or JSDOM threw (e.g., CSS parse errors on a hostile
		// page). Article extraction is optional; the bundle still has the
		// inner text, DOM and screenshots, so we report no article.
		return null;
	}
}

/** Write one text artifact to the bundle dir and return its path. */
function writeText(dir: string, name: string, content: string): string {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, content.slice(0, MAX_CONTENT_LENGTH), "utf-8");
	return filePath;
}

/** Write the screenshot tiles to the bundle dir and return their paths. */
function writeTiles(dir: string, tiles: string[]): string[] {
	return tiles.map((data, i) => {
		const name = `shot-${String(i + 1).padStart(2, "0")}.png`;
		const filePath = path.join(dir, name);
		fs.writeFileSync(filePath, Buffer.from(data, "base64"));
		return filePath;
	});
}

/**
 * Fetch a URL and capture it as a bundle of representations on disk:
 * article markdown, rendered inner text, DOM and screenshot tiles.
 */
export async function readPage(
	url: string,
	signal?: AbortSignal,
): Promise<PageBundle> {
	const page = await newPage();
	try {
		if (signal?.aborted) throw new Error("Aborted");

		await injectCookies(page, url);
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: PAGE_LOAD_TIMEOUT,
		});

		if (signal?.aborted) throw new Error("Aborted");

		await page.evaluate(
			(ms) => new Promise((r) => setTimeout(r, ms)),
			DYNAMIC_CONTENT_WAIT,
		);

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
		const rendered = cleanText(
			await page.evaluate(() => document.body.innerText ?? ""),
		);
		const article = await extractArticle(html, url);

		// The screenshot tiles come last because captureTiles resizes the
		// viewport and scrolls; the HTML and inner text are already captured.
		const { tiles, truncated } = await captureTiles(page);

		const id = crypto.randomBytes(6).toString("hex");
		const dir = path.join("/tmp", "pi-web-read", id);
		fs.mkdirSync(dir, { recursive: true });

		const title = article?.title || (await page.title());
		const excerpt = (article?.markdown || rendered).slice(0, EXCERPT_LENGTH);

		const articlePath = article
			? writeText(
					dir,
					"article.md",
					`# ${title}\n\nSource: ${url}\n\n${article.markdown}`,
				)
			: undefined;
		const innertextPath = rendered
			? writeText(dir, "innertext.txt", rendered)
			: undefined;
		const domPath = writeText(dir, "dom.html", html);
		const screenshots = writeTiles(dir, tiles);

		return {
			title,
			url,
			excerpt,
			dir,
			article: articlePath,
			innertext: innertextPath,
			dom: domPath,
			screenshots,
			truncated,
		};
	} finally {
		await page.close();
	}
}
