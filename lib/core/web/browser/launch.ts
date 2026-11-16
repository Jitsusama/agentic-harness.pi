/**
 * Starting Chrome: a headless launch against a fresh profile, with a
 * bounded retry, the endpoint a later process can join it by, and
 * joining a browser another process launched.
 *
 * Kept apart from the shared browser because the launch arguments,
 * the retry budget and the DevTools port discovery change with
 * Chrome and puppeteer, not with how the warm browser is shared.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout } from "node:timers";
import type { Browser } from "puppeteer-core";
import { headlessEnvironment, resolveChromePath } from "../chrome.ts";
import { BrowserLaunchFailed } from "./failure.ts";
import {
	isPidAlive,
	ownProfileDir,
	PROFILE_ROOT,
	readOwnerRecord,
	reapOrphanProfiles,
	writeOwnerRecord,
} from "./profile.ts";

/**
 * puppeteer, loaded when a browser is first launched or joined rather
 * than whenever this module is imported, since most sessions never
 * open one.
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

/** How long to wait for Chrome to publish the port it bound for
 * --remote-debugging-port=0, polling since the write lands on a
 * different schedule than the DevTools pipe launch() already waited on. */
const DEVTOOLS_PORT_TIMEOUT_MS = 2000;
const DEVTOOLS_PORT_POLL_MS = 50;

/** Path Chrome writes its bound remote-debugging port to. */
function devToolsActivePortFile(profileDir: string): string {
	return path.join(profileDir, "DevToolsActivePort");
}

/** Read the port Chrome bound for --remote-debugging-port=0, polling
 * briefly since the file is not necessarily there the instant launch()
 * resolves. Undefined when it never appears within the budget. */
async function readDevToolsPort(
	profileDir: string,
): Promise<number | undefined> {
	const deadline = Date.now() + DEVTOOLS_PORT_TIMEOUT_MS;
	for (;;) {
		try {
			const raw = fs.readFileSync(devToolsActivePortFile(profileDir), "utf8");
			const port = Number.parseInt(raw.split("\n")[0] ?? "", 10);
			if (Number.isFinite(port) && port > 0) return port;
		} catch {
			// Not written yet, or unreadable; keep polling until the deadline.
		}
		if (Date.now() >= deadline) return undefined;
		await sleep(DEVTOOLS_PORT_POLL_MS);
	}
}

/** Ask Chrome's DevTools HTTP endpoint for the browser-wide WebSocket URL
 * a separate process can connect() to. Best-effort: a failure here only
 * means cross-process reconnection is unavailable, never that the launch
 * itself failed. */
async function readBrowserWSEndpoint(
	port: number,
): Promise<string | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		const body: unknown = await res.json();
		const url = (body as { webSocketDebuggerUrl?: unknown })
			.webSocketDebuggerUrl;
		return typeof url === "string" ? url : undefined;
	} catch {
		return undefined;
	}
}

/** Launch headless Chrome once, against a freshly reset profile. */
async function launchOnce(executablePath: string): Promise<Browser> {
	const profileDir = ownProfileDir();
	// Reset the profile so a half-dead Chrome's SingletonLock from a
	// prior attempt cannot poison this one.
	fs.rmSync(profileDir, { recursive: true, force: true });
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
			// Two independent DevTools transports, both requested explicitly
			// (puppeteer only adds one itself, and only when args carries
			// neither): the pipe is what this process's own puppeteer.launch
			// connects over, unaffected by anything below. The port, bound to
			// loopback on a free port Chrome picks, exists purely so a later,
			// separate process can attach to this same browser instead of
			// launching its own; nothing here reads or writes it before then.
			"--remote-debugging-pipe",
			"--remote-debugging-port=0",
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
		// Talk to Chrome over stdio rather than a DevTools websocket for
		// *this* process's own connection. A websocket is a TCP handle
		// that holds the event loop and cannot be unref'd through
		// puppeteer's public surface, which is what kept a finished
		// script running until the idle close fired. Pipes can be. The
		// --remote-debugging-port above still gives a second, later
		// process a socket-based endpoint to reconnect over; that
		// process pays this same cost, but only while it is actually
		// using the browser, not this one, which never opens the port
		// itself.
		pipe: true,
	});
	const browserPid = browser.process()?.pid;
	// Discover and publish the reconnect endpoint. Best-effort and never
	// awaited-into-failure: any problem here leaves browserWSEndpoint
	// unset, which only means a later process falls back to launching
	// its own Chrome rather than reusing this one.
	let wsEndpoint: string | undefined;
	try {
		const port = await readDevToolsPort(profileDir);
		if (port !== undefined) wsEndpoint = await readBrowserWSEndpoint(port);
	} catch {
		// Same as above: reconnection is an optional extra.
	}
	// Record ownership so a later run can tell our live Chrome from an
	// orphan and know exactly which pid to reap.
	writeOwnerRecord(profileDir, browserPid, wsEndpoint);
	return browser;
}

/**
 * Attach to a browser a different, still-live process already launched,
 * instead of spawning one of our own. For a stateless-per-invocation
 * caller (a CLI, not a long-lived extension host that keeps its own
 * processGlobal state) that wants to reuse whatever browser is already
 * warm rather than paying a fresh launch every call.
 *
 * Scans every profile under PROFILE_ROOT for a live owner that published
 * a reconnectable endpoint, and attaches to the first one that answers.
 * Returns undefined when none is found or reachable, so the caller can
 * fall back to getBrowser().
 *
 * The caller does not own what this returns: closing it must be
 * `browser.disconnect()`, never `browser.close()`, which would tear down
 * the browser out from under the process that actually launched it.
 */
export async function connectShared(): Promise<Browser | undefined> {
	let entries: string[];
	try {
		entries = fs.readdirSync(PROFILE_ROOT);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const dir = path.join(PROFILE_ROOT, entry);
		const owner = readOwnerRecord(dir);
		if (!owner?.browserWSEndpoint || !isPidAlive(owner.ownerPid)) continue;
		try {
			return await (await puppeteer()).connect({
				browserWSEndpoint: owner.browserWSEndpoint,
			});
		} catch {
			// Stale endpoint (closed since the record was written) or an
			// unreachable one; try the next candidate rather than failing.
		}
	}
	return undefined;
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
