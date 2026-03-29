/**
 * Automatic Slack credential extraction via browser.
 *
 * Launches Chrome (non-headless, using the user's existing
 * install), navigates to Slack, and polls localStorage and
 * cookies for the xoxc- token and xoxd- cookie. Works with
 * any Slack workspace — the user just needs to be logged in
 * (or log in when the browser opens).
 *
 * Uses puppeteer-core (no bundled browser) for consistency
 * with web-search-integration.
 */

import * as fs from "node:fs";
import puppeteer from "puppeteer-core";

/** Default Slack URL to navigate to. */
const DEFAULT_SLACK_URL = "https://app.slack.com";

/** How often to poll for credentials (milliseconds). */
const POLL_INTERVAL_MS = 1000;

/** Default timeout: 5 minutes to allow for SSO, 2FA, workspace selection. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Paths where Chrome might be installed. */
const CHROME_PATHS = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

/** Extracted browser session credentials. */
export interface BrowserCredentials {
	token: string;
	cookie: string;
}

/** Find the Chrome executable on disk. */
function findChrome(): string {
	const envPath = process.env.CHROME_PATH;
	if (envPath && fs.existsSync(envPath)) return envPath;

	for (const p of CHROME_PATHS) {
		try {
			if (fs.existsSync(p)) return p;
		} catch {
			// Not at this path, try next.
		}
	}
	throw new Error(
		"Chrome not found. Install Google Chrome or set CHROME_PATH.",
	);
}

/**
 * Launch Chrome, navigate to Slack, and extract credentials.
 *
 * Opens a visible browser window so the user can log in if
 * needed. Polls localStorage for the xoxc- token and the
 * browser's cookie jar for the xoxd- session cookie.
 *
 * @param slackUrl - Slack workspace URL (default: app.slack.com)
 * @param timeoutMs - How long to wait before giving up
 */
export async function extractFromBrowser(
	slackUrl = DEFAULT_SLACK_URL,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BrowserCredentials> {
	const chromePath = findChrome();
	const browser = await puppeteer.launch({
		executablePath: chromePath,
		headless: false,
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	});

	try {
		const context = browser.defaultBrowserContext();
		const page = (await browser.pages())[0] ?? (await browser.newPage());
		await page.goto(slackUrl, { waitUntil: "domcontentloaded" });

		const startTime = Date.now();

		while (Date.now() - startTime < timeoutMs) {
			// Grab the most recent page — Slack and SSO flows may open
			// new tabs or navigate, destroying the original context.
			const pages = await browser.pages();
			const activePage = pages[pages.length - 1] ?? page;

			// The cookie lives in the browser context, not the page,
			// so it survives navigations. Check it first.
			const cookies = await context.cookies();
			const dCookie = cookies.find(
				(c) => c.name === "d" && c.domain.includes("slack.com"),
			);
			const cookie = dCookie?.value;

			// Try to read the token from localStorage. This fails during
			// navigations (context destroyed) and on non-Slack pages
			// (SSO provider). Both are expected — we just retry.
			const token = await extractTokenFromPage(activePage);

			if (token?.startsWith("xoxc-") && cookie?.startsWith("xoxd-")) {
				return { token, cookie };
			}

			await sleep(POLL_INTERVAL_MS);
		}

		throw new Error(
			"Timed out waiting for Slack credentials. " +
				"Make sure you are logged into Slack in the browser window.",
		);
	} finally {
		await browser.close();
	}
}

/**
 * Try to extract the xoxc- token from a page's localStorage.
 *
 * Returns null if the page isn't on Slack yet, is mid-navigation,
 * or the execution context was destroyed. All expected during
 * SSO flows.
 */
async function extractTokenFromPage(
	page: import("puppeteer-core").Page,
): Promise<string | null> {
	try {
		return await page.evaluate(() => {
			try {
				const raw = localStorage.getItem("localConfig_v2");
				if (!raw) return null;
				const config = JSON.parse(raw);
				const teams = config?.teams;
				if (!teams) return null;
				for (const t of Object.values(teams) as Array<
					Record<string, unknown>
				>) {
					const tok = t?.token as string | undefined;
					if (tok?.startsWith("xoxc-")) return tok;
				}
				return null;
			} catch {
				return null;
			}
		});
	} catch {
		// Execution context destroyed (navigation), page closed, or
		// cross-origin frame (SSO provider). All expected — retry.
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
