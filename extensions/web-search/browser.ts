/**
 * Browser lifecycle — launch Chrome once, reuse across tool calls.
 * Also handles injecting the user's Chrome session cookies into
 * headless pages so authenticated sites work transparently.
 */

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { getCookiesForUrl, StaleKeyError } from "./cookies.js";

let browser: Browser | undefined;

const CHROME_PATHS = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

function findChrome(): string {
	for (const p of CHROME_PATHS) {
		try {
			const fs = require("node:fs");
			if (fs.existsSync(p)) return p;
		} catch {
			continue;
		}
	}
	throw new Error(
		"Chrome not found. Install Google Chrome or set CHROME_PATH.",
	);
}

export async function getBrowser(): Promise<Browser> {
	if (browser?.connected) return browser;
	const executablePath = process.env.CHROME_PATH || findChrome();
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--disable-logging",
			"--log-level=3",
		],
		// Suppress Chrome's stderr noise
		dumpio: false,
	});
	return browser;
}

export async function newPage(): Promise<Page> {
	const b = await getBrowser();
	const page = await b.newPage();
	await page.setUserAgent(
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
			"AppleWebKit/537.36 (KHTML, like Gecko) " +
			"Chrome/131.0.0.0 Safari/537.36",
	);
	return page;
}

/**
 * Inject the user's Chrome session cookies for a URL into a
 * puppeteer page. Best-effort — if cookies can't be read (no
 * Chrome profile, Keychain denied, etc.) we silently continue
 * without them.
 */
export async function injectCookies(page: Page, url: string): Promise<void> {
	try {
		const cookies = await getCookiesForUrl(url);
		if (cookies.length) {
			await page.setCookie(...cookies);
		}
	} catch (err) {
		// Let stale key errors propagate so the user gets guidance
		if (err instanceof StaleKeyError) throw err;
		// Silent fallback for everything else — cookies are optional
	}
}

export async function closeBrowser(): Promise<void> {
	if (browser?.connected) {
		await browser.close();
		browser = undefined;
	}
}
