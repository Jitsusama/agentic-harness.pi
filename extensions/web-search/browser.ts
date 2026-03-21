/**
 * Browser lifecycle: launch Chrome once, reuse across tool calls.
 * Pure Chrome management: no cookie knowledge.
 */

import * as fs from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

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
			if (fs.existsSync(p)) return p;
		} catch {
			// Chrome isn't installed at this path, so we try the next one.
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

export async function closeBrowser(): Promise<void> {
	if (browser?.connected) {
		await browser.close();
		browser = undefined;
	}
}
