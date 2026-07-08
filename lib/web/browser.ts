/**
 * Browser lifecycle: launch Chrome once, reuse across tool calls.
 * Pure Chrome management: no cookie knowledge.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

let browser: Browser | undefined;

/**
 * Parent dir for per-launch Chrome profiles. Each launch gets
 * its own subdir; a startup sweep removes the ones left behind
 * by a prior run that a SIGKILL or crash could not clean, which
 * is the orphan the clean-exit teardown never reclaims.
 */
const PROFILE_ROOT = path.join(os.tmpdir(), "pi-web-chrome");
let lifecycleInstalled = false;

/** Remove profile dirs from earlier runs (their Chrome is long dead). */
function sweepOrphanProfiles(): void {
	try {
		for (const entry of fs.readdirSync(PROFILE_ROOT)) {
			if (entry === String(process.pid)) continue;
			fs.rmSync(path.join(PROFILE_ROOT, entry), {
				recursive: true,
				force: true,
			});
		}
	} catch {
		// No profile root yet, or a dir in use by a live sibling; the
		// next startup sweeps whatever this one could not.
	}
}

/**
 * Kill Chrome and exit on the signals that would otherwise
 * orphan it (SIGINT, SIGTERM, SIGHUP), and on clean exit. A
 * hard-killed subagent gets SIGTERM, so this is what keeps the
 * RELY01 orphan from accumulating.
 */
function installLifecycleHandlers(): void {
	if (lifecycleInstalled) return;
	lifecycleInstalled = true;
	process.once("exit", killBrowserSync);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			killBrowserSync();
			process.exit(0);
		});
	}
}

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

/** Get the shared headless Chrome instance, launching it if needed. */
export async function getBrowser(): Promise<Browser> {
	if (browser?.connected) return browser;
	installLifecycleHandlers();
	sweepOrphanProfiles();
	const profileDir = path.join(PROFILE_ROOT, String(process.pid));
	fs.mkdirSync(profileDir, { recursive: true });
	const executablePath = process.env.CHROME_PATH || findChrome();
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		userDataDir: profileDir,
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

/** Open a new browser tab with a standard user agent string. */
export async function newPage(): Promise<Page> {
	const b = await getBrowser();
	const page = await b.newPage();
	try {
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
				"AppleWebKit/537.36 (KHTML, like Gecko) " +
				"Chrome/131.0.0.0 Safari/537.36",
		);
	} catch (err) {
		await page.close();
		throw err;
	}
	return page;
}

/** Shut down the shared Chrome instance if it's running. */
export async function closeBrowser(): Promise<void> {
	const b = browser;
	if (!b) return;

	try {
		if (b.connected) await b.close();
	} catch {
		// Graceful close failed. Kill the Chrome process tree so it
		// doesn't linger as an orphan.
		b.process()?.kill("SIGKILL");
	} finally {
		browser = undefined;
	}
}

/**
 * Force-kill the Chrome process synchronously. Called from
 * `process.on('exit')` where async work isn't possible.
 */
export function killBrowserSync(): void {
	const b = browser;
	if (!b) return;

	b.process()?.kill("SIGKILL");
	browser = undefined;
}
