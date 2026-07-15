/**
 * Page reader: fetches a URL with headless Chrome and captures it as a
 * bundle of representations the model can pick and choose from.
 *
 * Every read settles the page once (capture-width viewport, dynamic-content
 * wait, lazy-content scroll) and then snapshots article markdown (via
 * defuddle), the rendered inner text, the DOM and a bounded stack of
 * screenshot tiles from that one state. The artifacts are written to a
 * private per-read directory; the caller turns the returned paths into a
 * pointer manifest so the model opens only what it needs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Defuddle } from "defuddle/node";
import { JSDOM, VirtualConsole } from "jsdom";
import { newPage } from "./browser.js";
import { injectCookies, isSetUp } from "./cookies/index.js";
import { captureTiles, preparePage } from "./screenshot.js";

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
 * A page captured as a bundle of representations on disk. Each path points
 * at one representation in `dir`; the model opens whichever it needs. The
 * DOM is always captured, so `domPath` is required; the article is present
 * only when extraction found one.
 */
export interface PageBundle {
	title: string;
	/** The final URL after any redirects, which is what was actually read. */
	url: string;
	/** A short inline snippet so the model can judge relevance without opening a file. */
	excerpt: string;
	/** The bundle directory holding every artifact. */
	dir: string;
	/** Path to the cleaned article markdown, when extraction found an article. */
	articlePath?: string;
	/** Path to the rendered inner text, when the page had any. */
	innerTextPath?: string;
	/** Path to the rendered DOM (HTML). Always written. */
	domPath: string;
	/** Paths to the screenshot tiles, top to bottom. */
	screenshotPaths: string[];
	/** True when the page ran past the screenshot tile budget and was cut short. */
	truncated: boolean;
}

/** Extracted article from defuddle: markdown content, title and word count. */
export interface Article {
	markdown: string;
	title: string;
	wordCount: number;
}

/**
 * The raw representations captured from a settled page, before they are
 * written to disk. Keeps capture (browser I/O) separate from assembly
 * (pure file layout) so the assembly is testable without a browser.
 */
export interface Captured {
	/** The final URL after redirects. */
	url: string;
	title: string;
	html: string;
	innerText: string;
	article: Article | null;
	/** Base64 PNG tiles, top to bottom. */
	tiles: string[];
	truncated: boolean;
}

/**
 * The disk side of bundle assembly, injected so assembly can be tested
 * without touching the filesystem. The real sink creates a private
 * directory and writes each artifact with owner-only permissions.
 */
export interface BundleSink {
	dir: string;
	/** Write a text artifact and return its path. */
	writeText(name: string, content: string): string;
	/** Write a binary artifact from base64 and return its path. */
	writeBinary(name: string, base64: string): string;
}

/** Timeout for page navigation in milliseconds. */
const PAGE_LOAD_TIMEOUT = 20_000;

/** Wait time for dynamic content to render after load. */
const DYNAMIC_CONTENT_WAIT = 1_500;

/** Characters of the best available text used for the inline excerpt. */
const EXCERPT_LENGTH = 500;

/** Below this word count we treat defuddle's article as empty and skip it. */
const MIN_ARTICLE_WORDS = 30;

/** Upper bound on the page-controlled title we carry inline. */
const MAX_TITLE_LENGTH = 300;

/** Root under the system temp dir for all page bundles. */
const BUNDLE_ROOT = path.join(os.tmpdir(), "pi-web-read");

/** Owner-only directory permissions for a bundle. */
const DIR_MODE = 0o700;

/** Owner-only file permissions for a bundle artifact. */
const FILE_MODE = 0o600;

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
 * Assemble a bundle from captured representations by writing each one in
 * full through the sink. The DOM is always written; the article and inner
 * text are written only when present; every screenshot tile gets an
 * ordered, zero-padded name. The page-controlled title is bounded.
 */
export function assembleBundle(
	captured: Captured,
	sink: BundleSink,
): PageBundle {
	const title = captured.title.slice(0, MAX_TITLE_LENGTH);
	const body = captured.article?.markdown || captured.innerText;
	const excerpt = body.slice(0, EXCERPT_LENGTH);

	const articlePath = captured.article
		? sink.writeText(
				"article.md",
				`# ${title}\n\nSource: ${captured.url}\n\n${captured.article.markdown}`,
			)
		: undefined;
	const innerTextPath = captured.innerText
		? sink.writeText("innertext.txt", captured.innerText)
		: undefined;
	const domPath = sink.writeText("dom.html", captured.html);
	const screenshotPaths = captured.tiles.map((data, i) =>
		sink.writeBinary(`shot-${String(i + 1).padStart(2, "0")}.png`, data),
	);

	return {
		title,
		url: captured.url,
		excerpt,
		dir: sink.dir,
		articlePath,
		innerTextPath,
		domPath,
		screenshotPaths,
		truncated: captured.truncated,
	};
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

/**
 * Run defuddle over the page HTML to extract the main content as markdown,
 * resolving relative links against the final URL. Returns null when
 * defuddle throws or finds too little to be a real article.
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

/** A filesystem sink that creates a private bundle dir and writes 0600 files. */
export function diskSink(root: string = BUNDLE_ROOT): BundleSink {
	fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
	// The "r-" prefix keeps the temp dir inside root, where the reaper
	// looks, rather than creating a sibling of it.
	const dir = fs.mkdtempSync(path.join(root, "r-"));
	fs.chmodSync(dir, DIR_MODE);
	return {
		dir,
		writeText(name, content) {
			const filePath = path.join(dir, name);
			fs.writeFileSync(filePath, content, {
				encoding: "utf-8",
				mode: FILE_MODE,
			});
			return filePath;
		},
		writeBinary(name, base64) {
			const filePath = path.join(dir, name);
			fs.writeFileSync(filePath, Buffer.from(base64, "base64"), {
				mode: FILE_MODE,
			});
			return filePath;
		},
	};
}

/**
 * Remove bundle directories older than the given age. Run at session start
 * to reclaim authenticated captures left by prior sessions and crashes,
 * without tracking directories across sessions.
 */
export function reapStaleBundles(
	maxAgeMs: number,
	now = Date.now(),
	root: string = BUNDLE_ROOT,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// No bundle root yet, nothing to reap.
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		try {
			const age = now - fs.statSync(dir).mtimeMs;
			if (age > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// The directory vanished under us or is unreadable; skip it.
		}
	}
}

/** Throw if the operation has been cancelled. */
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Aborted");
}

/**
 * Fetch a URL and capture it as a bundle of representations on disk:
 * article markdown, rendered inner text, DOM and screenshot tiles. All
 * representations are taken from one settled page state.
 */
export async function readPage(
	url: string,
	signal?: AbortSignal,
): Promise<PageBundle> {
	const page = await newPage();
	try {
		throwIfAborted(signal);

		await injectCookies(page, url);
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: PAGE_LOAD_TIMEOUT,
		});

		throwIfAborted(signal);

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

		throwIfAborted(signal);

		// Settle the page once (capture-width viewport, lazy-content scroll)
		// so text, DOM and screenshots all reflect the same rendered state.
		await preparePage(page);

		const html = await page.content();
		const rendered = cleanText(
			await page.evaluate(
				() =>
					document.body?.innerText ??
					document.documentElement?.textContent ??
					"",
			),
		);
		const article = await extractArticle(html, finalUrl);
		const title = article?.title || (await page.title());

		throwIfAborted(signal);

		// Screenshots are always captured so a text-only bundle still carries
		// a visual representation the model can fall back to.
		const { tiles, truncated } = await captureTiles(page);

		throwIfAborted(signal);

		return assembleBundle(
			{
				url: finalUrl,
				title,
				html,
				innerText: rendered,
				article,
				tiles,
				truncated,
			},
			diskSink(),
		);
	} finally {
		await page.close();
	}
}
