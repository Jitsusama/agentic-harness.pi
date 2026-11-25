/**
 * Starting Chrome: a headless launch against a fresh profile, with a
 * bounded retry, reachable only over the pipe the launching process
 * holds.
 *
 * Kept apart from the shared browser because the launch arguments and
 * the retry budget change with Chrome and puppeteer, not with how the
 * warm browser is shared.
 */

import * as fs from "node:fs";
import { setTimeout } from "node:timers";
import type { Browser } from "puppeteer-core";
import { removeTree } from "../../../internal/files/remove-tree.ts";
import { headlessEnvironment, resolveChromePath } from "../chrome.ts";
import { BrowserLaunchFailed } from "./failure.ts";
import {
	ownProfileDir,
	reapOrphanProfiles,
	writeOwnerRecord,
} from "./profile.ts";

/**
 * puppeteer, loaded when a browser is first launched rather than
 * whenever this module is imported, since most sessions never open one.
 */
async function puppeteer() {
	return (await import("puppeteer-core")).default;
}

/** How many times to try launching Chrome before giving up. */
const LAUNCH_ATTEMPTS = 3;

/** Backoff before each retry, in milliseconds. The array length is
 * LAUNCH_ATTEMPTS - 1; a Chrome self-update window clears in seconds. */
const LAUNCH_BACKOFF_MS = [500, 1500];

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Launch headless Chrome once, against a freshly reset profile. */
async function launchOnce(executablePath: string): Promise<Browser> {
	const profileDir = ownProfileDir();
	// Reset the profile so a half-dead Chrome's SingletonLock from a
	// prior attempt cannot poison this one.
	removeTree(profileDir);
	fs.mkdirSync(profileDir, { recursive: true });
	const browser = await (await puppeteer()).launch({
		executablePath,
		headless: true,
		userDataDir: profileDir,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			// Route Chrome's own errors to stderr (at v=0, errors only) so
			// a failed launch carries a real reason. dumpio stays false, so
			// none of this reaches the user's terminal on success.
			"--enable-logging=stderr",
			"--v=0",
			// DevTools over the pipe alone, asked for outright so puppeteer
			// adds no port of its own. A port, even on loopback, answers
			// any process on the machine with no key, an agent's fenced
			// command among them, and DevTools drives this whole unfenced
			// browser: it reads files by file://, writes downloads anywhere
			// and signs with the device's certificate.
			"--remote-debugging-pipe",
		],
		dumpio: false,
		// Off the session bus, so Chrome can't move itself into the
		// person's app.slice and stays in this session's.
		env: headlessEnvironment(),
		// Puppeteer's own handlers kill Chrome and then call process.exit,
		// taking the exit from the host; the ones above kill it without.
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
		// Talk to Chrome over stdio rather than a DevTools websocket. A
		// websocket is a TCP handle that holds the event loop and cannot
		// be unref'd through puppeteer's public surface, which is what
		// kept a finished script running until the idle close fired.
		// Pipes can be.
		pipe: true,
	});
	// Record ownership so a later run can tell our live Chrome from an
	// orphan and know exactly which pid to reap.
	writeOwnerRecord(profileDir, browser.process()?.pid);
	return browser;
}

/**
 * Launch Chrome with a bounded retry. A Chrome self-update on macOS
 * makes the first spawn exit before its DevTools endpoint appears;
 * the window is brief, so a short backoff usually rides it out. A
 * failed puppeteer.launch group-kills its own child, and each
 * attempt resets the profile, so retries never stack orphans. The
 * caller installs the teardown handlers first.
 */
export async function launchChrome(): Promise<Browser> {
	reapOrphanProfiles();
	// Resolve the binary once, before the loop. A missing Chrome is a
	// settled misconfig, not a transient, so it throws its own clear
	// error immediately instead of being retried or sniffed for by
	// message text.
	const executablePath = resolveChromePath(process.env.CHROME_PATH);
	let lastError: unknown;
	for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
		try {
			return await launchOnce(executablePath);
		} catch (err) {
			lastError = err;
			const backoff = LAUNCH_BACKOFF_MS[attempt - 1];
			if (backoff !== undefined) await sleep(backoff);
		}
	}
	throw new BrowserLaunchFailed(lastError, LAUNCH_ATTEMPTS);
}
