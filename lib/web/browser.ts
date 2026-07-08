/**
 * Browser lifecycle: launch Chrome once, reuse across tool calls.
 * Pure Chrome management: no cookie knowledge.
 *
 * The singleton lives on globalThis rather than in a module
 * variable. Pi loads each extension as its own module instance,
 * so a module-level singleton would give web search, mermaid and
 * the browser tool a browser each, all racing to launch Chrome
 * against the same per-pid profile; the first wins the profile
 * lock and the rest fail to launch. A process-global instance,
 * plus a shared in-flight launch promise, means one browser and
 * one profile no matter how many extensions reach for it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/** Process-global browser state, shared across extension module instances. */
interface SharedBrowserState {
	browser?: Browser;
	launching?: Promise<Browser>;
	lifecycleInstalled?: boolean;
}

const STATE_KEY = Symbol.for("pi:web-shared-browser");

function sharedState(): SharedBrowserState {
	const store = globalThis as Record<symbol, SharedBrowserState | undefined>;
	store[STATE_KEY] ??= {};
	// biome-ignore lint/style/noNonNullAssertion: assigned on the line above.
	return store[STATE_KEY]!;
}

/**
 * Parent dir for per-launch Chrome profiles. Each launch gets
 * its own subdir; a startup sweep removes the ones left behind
 * by a prior run that a SIGKILL or crash could not clean, which
 * is the orphan the clean-exit teardown never reclaims.
 */
const PROFILE_ROOT = path.join(os.tmpdir(), "pi-web-chrome");

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
	const state = sharedState();
	if (state.lifecycleInstalled) return;
	state.lifecycleInstalled = true;
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

/** Launch a fresh headless Chrome against this process's profile. */
async function launchBrowser(): Promise<Browser> {
	installLifecycleHandlers();
	sweepOrphanProfiles();
	const profileDir = path.join(PROFILE_ROOT, String(process.pid));
	fs.mkdirSync(profileDir, { recursive: true });
	const executablePath = process.env.CHROME_PATH || findChrome();
	return puppeteer.launch({
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
}

/**
 * Get the shared headless Chrome instance, launching it if
 * needed. Concurrent callers share one in-flight launch, so two
 * extensions reaching for the browser in the same tick do not
 * race two Chrome processes onto the same profile.
 */
export async function getBrowser(): Promise<Browser> {
	const state = sharedState();
	if (state.browser?.connected) return state.browser;
	if (state.launching) return state.launching;
	state.launching = launchBrowser();
	try {
		state.browser = await state.launching;
		return state.browser;
	} finally {
		state.launching = undefined;
	}
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
	const state = sharedState();
	const b = state.browser;
	if (!b) return;

	try {
		if (b.connected) await b.close();
	} catch {
		// Graceful close failed. Kill the Chrome process tree so it
		// doesn't linger as an orphan.
		b.process()?.kill("SIGKILL");
	} finally {
		state.browser = undefined;
	}
}

/**
 * Force-kill the Chrome process synchronously. Called from
 * `process.on('exit')` where async work isn't possible.
 */
export function killBrowserSync(): void {
	const state = sharedState();
	const b = state.browser;
	if (!b) return;

	b.process()?.kill("SIGKILL");
	state.browser = undefined;
}
