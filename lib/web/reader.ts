/**
 * Page reader: fetches a URL with headless Chrome and captures it as a
 * bundle of representations the model can pick and choose from.
 *
 * Every read settles the page once (capture-width viewport, dynamic-content
 * wait, lazy-content scroll) and then snapshots article markdown (via
 * defuddle), the rendered inner text, the DOM and a bounded stack of
 * screenshot tiles from that one state. Artifacts are written to a private,
 * per-session directory keyed by process id, so a crashed session's
 * captures can be reaped without touching a live one. The caller turns the
 * returned paths into a pointer manifest so the model opens only what it
 * needs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Defuddle } from "defuddle/node";
import { JSDOM, VirtualConsole } from "jsdom";
import type { Page } from "puppeteer-core";
import { isPidAlive, newPage } from "./browser.js";
import { injectCookies, isSetUp } from "./cookies/index.js";
import { captureTiles, preparePage, type TiledCapture } from "./screenshot.js";

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
 * (pure file layout) so each is testable on its own.
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

/** Collaborators of `capturePage`, injected so the orchestration is testable. */
export interface CaptureDeps {
	preparePage(page: Page): Promise<void>;
	captureTiles(page: Page): Promise<TiledCapture>;
	extractArticle(html: string, url: string): Promise<Article | null>;
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

/**
 * Upper bound on any single text artifact written to disk. Generous enough
 * that real pages are never touched, but it caps a pathological page so it
 * cannot fill the disk. When it bites, the file says so in-band rather than
 * ending silently.
 */
const MAX_ARTIFACT_CHARS = 5_000_000;

/** Root under the system temp dir for this platform's page bundles. */
const BUNDLE_ROOT = path.join(os.tmpdir(), "pi-web-read");

/** Where earlier versions wrote bundles, swept by age so they don't linger. */
const LEGACY_BUNDLE_ROOT = "/tmp/pi-web-read";

/** Age past which a legacy bundle directory is reaped. */
const LEGACY_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

/** Owner-only directory permissions for a bundle. */
const DIR_MODE = 0o700;

/** Owner-only file permissions for a bundle artifact. */
const FILE_MODE = 0o600;

/** URL fragments that mark a redirect to an auth provider. */
const AUTH_URL_MARKERS = [
	"accounts.google.com",
	"/oauth",
	"/login",
	"/signin",
	"/auth",
];

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

/** True when a final URL indicates a redirect to an auth provider. */
export function isAuthRedirect(url: string): boolean {
	return AUTH_URL_MARKERS.some((marker) => url.includes(marker));
}

/** Collapse a page-controlled string to a single trimmed line. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Cap a text artifact at the size bound, appending a visible marker when it
 * bites so a reader never mistakes a cut-off file for a complete one.
 */
function capArtifact(content: string): string {
	if (content.length <= MAX_ARTIFACT_CHARS) return content;
	return `${content.slice(0, MAX_ARTIFACT_CHARS)}\n\n[truncated at ${MAX_ARTIFACT_CHARS} characters]`;
}

/**
 * Assemble a bundle from captured representations by writing each one
 * through the sink. The DOM is always written; the article and inner text
 * are written only when present; every screenshot tile gets an ordered,
 * zero-padded name. Text is capped with a visible marker, and the
 * page-controlled title and excerpt are flattened to a single line so they
 * cannot impersonate the manifest's own structure.
 */
export function assembleBundle(
	captured: Captured,
	sink: BundleSink,
): PageBundle {
	const title = oneLine(captured.title).slice(0, MAX_TITLE_LENGTH);
	const body = captured.article?.markdown || captured.innerText;
	const excerpt = oneLine(body).slice(0, EXCERPT_LENGTH);

	const articlePath = captured.article
		? sink.writeText(
				"article.md",
				capArtifact(
					`# ${title}\n\nSource: ${captured.url}\n\n${captured.article.markdown}`,
				),
			)
		: undefined;
	const innerTextPath = captured.innerText
		? sink.writeText("innertext.txt", capArtifact(captured.innerText))
		: undefined;
	const domPath = sink.writeText("dom.html", capArtifact(captured.html));
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

/** This session's private bundle directory, keyed by process id. */
function sessionDir(): string {
	return path.join(BUNDLE_ROOT, String(process.pid));
}

/** A filesystem sink that creates a private bundle dir and writes 0600 files. */
export function diskSink(root: string = sessionDir()): BundleSink {
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

/** Remove immediate subdirectories of `root` for which `stale` returns true. */
function reapDir(
	root: string,
	stale: (dir: string, name: string) => boolean,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// The root does not exist, so there is nothing to reap.
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		try {
			if (stale(dir, entry.name))
				fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// The directory vanished under us or is unreadable; skip it.
		}
	}
}

/**
 * Reap bundle directories that no live session owns. The current root is
 * keyed by process id, so a directory is abandoned exactly when its pid is
 * no longer alive; the legacy root predates pid keying and is swept by age.
 * The collaborators are parameters so the destructive sweep is testable
 * against a throwaway root.
 */
export function reapBundles(opts: {
	root: string;
	legacyRoot: string;
	isPidAlive: (pid: number) => boolean;
	now: number;
	legacyMaxAgeMs: number;
}): void {
	reapDir(opts.root, (_dir, name) => {
		const pid = Number(name);
		return Number.isInteger(pid) && !opts.isPidAlive(pid);
	});
	reapDir(opts.legacyRoot, (dir) => {
		try {
			return opts.now - fs.statSync(dir).mtimeMs > opts.legacyMaxAgeMs;
		} catch {
			return false;
		}
	});
}

/**
 * Reap bundle directories left behind by sessions that are no longer
 * running. Safe to call at session start; it never touches a live
 * session's directory.
 */
export function reapAbandonedBundles(): void {
	reapBundles({
		root: BUNDLE_ROOT,
		legacyRoot: LEGACY_BUNDLE_ROOT,
		isPidAlive,
		now: Date.now(),
		legacyMaxAgeMs: LEGACY_MAX_AGE_MS,
	});
}

/** Remove this session's bundle directory. Call at session shutdown. */
export function cleanupSessionBundles(): void {
	try {
		fs.rmSync(sessionDir(), { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; the reaper reclaims it later if this fails.
	}
}

/** Throw if the operation has been cancelled. */
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Aborted");
}

const defaultCaptureDeps: CaptureDeps = {
	preparePage,
	captureTiles,
	extractArticle,
};

/**
 * Navigate a prepared page and capture every representation from one
 * settled state: DOM, inner text, article and screenshot tiles. Relative
 * links resolve against the final redirected URL, and a missing document
 * body falls back to the document text so non-HTML pages still yield a
 * capture. Cancellation is honoured between the expensive steps.
 */
export async function capturePage(
	page: Page,
	url: string,
	signal?: AbortSignal,
	deps: CaptureDeps = defaultCaptureDeps,
): Promise<Captured> {
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
	if (isAuthRedirect(finalUrl) && !isSetUp()) {
		throw new AuthSetupNeeded();
	}

	throwIfAborted(signal);

	// Settle the page once so text, DOM and screenshots agree on one state.
	await deps.preparePage(page);

	const html = await page.content();
	const rendered = cleanText(
		await page.evaluate(
			() =>
				document.body?.innerText ?? document.documentElement?.textContent ?? "",
		),
	);
	const article = await deps.extractArticle(html, finalUrl);
	const title = article?.title || (await page.title());

	throwIfAborted(signal);

	// Screenshots are always captured so a text-only bundle still carries a
	// visual representation the model can fall back to.
	const { tiles, truncated } = await deps.captureTiles(page);

	throwIfAborted(signal);

	return {
		url: finalUrl,
		title,
		html,
		innerText: rendered,
		article,
		tiles,
		truncated,
	};
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
		throwIfAborted(signal);
		await injectCookies(page, url);
		const captured = await capturePage(page, url, signal);
		const sink = diskSink();
		try {
			return assembleBundle(captured, sink);
		} catch (err) {
			// Don't leave a half-written bundle behind on a failed assembly.
			fs.rmSync(sink.dir, { recursive: true, force: true });
			throw err;
		}
	} finally {
		await page.close();
	}
}
