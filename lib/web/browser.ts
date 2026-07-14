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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { processGlobal } from "../internal/process-global.js";

/** How many times to try launching Chrome before giving up. */
const LAUNCH_ATTEMPTS = 3;

/** Backoff before each retry, in milliseconds. The array length is
 * LAUNCH_ATTEMPTS - 1; a Chrome self-update window clears in seconds. */
const LAUNCH_BACKOFF_MS = [500, 1500];

/** Close the shared browser after this long with no new page opened. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Diagnostic detail teased out of a failed Chrome launch. */
export interface LaunchFailureInfo {
	exitCode?: number;
	chromeStderr?: string;
}

/** Parse a Puppeteer launch error into an exit code and Chrome's stderr. */
export function classifyLaunchError(err: unknown): LaunchFailureInfo {
	const message = err instanceof Error ? err.message : String(err);
	const info: LaunchFailureInfo = {};
	const code = message.match(/Code:\s*(\d+)/);
	if (code) info.exitCode = Number(code[1]);
	// Puppeteer frames Chrome's own output between a `stderr:` header
	// and its troubleshooting footer; lift whatever sits in between.
	const stderr = message.match(/stderr:\s*\n([\s\S]*?)\n\s*TROUBLESHOOTING/);
	const captured = stderr?.[1]?.trim();
	if (captured) info.chromeStderr = captured;
	return info;
}

/** Build a human-readable message for a launch that never came up. */
export function formatLaunchFailure(
	info: LaunchFailureInfo,
	attempts: number,
): string {
	const code =
		info.exitCode === undefined ? "" : ` (exit code ${info.exitCode})`;
	const lines = [
		`Chrome could not be launched after ${attempts} attempts${code}.`,
		"This is often transient on macOS when Chrome is auto-updating in " +
			"the background, and retrying in a minute usually clears it. If it " +
			"keeps failing, check that Google Chrome opens normally, or set " +
			"CHROME_PATH to a working binary.",
	];
	if (info.chromeStderr) lines.push("", "Chrome said:", info.chromeStderr);
	return lines.join("\n");
}

/** Thrown when Chrome could not be launched after the retry budget. */
export class BrowserLaunchFailed extends Error {
	readonly exitCode?: number;
	readonly chromeStderr?: string;
	constructor(info: LaunchFailureInfo, attempts: number) {
		super(formatLaunchFailure(info, attempts));
		this.name = "BrowserLaunchFailed";
		this.exitCode = info.exitCode;
		this.chromeStderr = info.chromeStderr;
	}
}

/** Signal delivery, injectable so the reaping logic is testable. */
type GroupKill = (pid: number, signal: string) => void;

const defaultGroupKill: GroupKill = (pid, signal) => {
	process.kill(pid, signal);
};

/**
 * Kill a detached Chrome's whole process group, falling back to the
 * bare pid. Chrome is spawned detached, so its pgid equals its pid;
 * the negative pid reaps every helper (GPU, network, renderers) that
 * a lone pid kill would leave to reparent to launchd.
 */
export function killPidGroup(
	pid: number,
	groupKill: GroupKill = defaultGroupKill,
): void {
	try {
		groupKill(-pid, "SIGKILL");
	} catch {
		// The group is gone or unkillable; try the leader on its own.
		try {
			groupKill(pid, "SIGKILL");
		} catch {
			// Nothing left to kill; the process already exited.
		}
	}
}

/** Kill a live browser process tree: group first, then proc.kill fallback. */
export function killTree(
	proc:
		| { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }
		| null
		| undefined,
	groupKill: GroupKill = defaultGroupKill,
): void {
	const pid = proc?.pid;
	if (!proc || !pid) return;
	try {
		groupKill(-pid, "SIGKILL");
	} catch {
		// Group kill failed; fall back to Puppeteer's own process handle.
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already dead.
		}
	}
}

/** Inputs for reaping Chrome processes and profile dirs a dead pi left behind. */
export interface ReapOrphansOptions {
	root: string;
	currentPid: number;
	listEntries: () => string[];
	findProcs: (profileDir: string) => number[];
	killPid: (pid: number) => void;
	removeDir: (dir: string) => void;
}

/** Kill orphaned Chrome trees, then remove their stale profile dirs. */
export function reapOrphans(opts: ReapOrphansOptions): void {
	for (const entry of opts.listEntries()) {
		if (entry === String(opts.currentPid)) continue;
		const dir = path.join(opts.root, entry);
		// Argv-path match is the interlock against pid reuse: only a
		// process that still names this exact profile dir is ours to kill.
		for (const pid of opts.findProcs(dir)) {
			try {
				opts.killPid(pid);
			} catch {
				// A kill can lose a race with the process exiting; the dir
				// removal below still reclaims the space.
			}
		}
		opts.removeDir(dir);
	}
}

/** A countdown that closes an idle browser and rearms on use. */
export interface IdleCloser {
	touch(): void;
	cancel(): void;
}

/** Inputs for the idle-close countdown; timers are injectable for tests. */
export interface IdleCloserOptions {
	idleMs: number;
	close: () => void;
	setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (id: NodeJS.Timeout) => void;
}

/** Build an idle-close countdown that rearms on touch and stops on cancel. */
export function createIdleCloser(opts: IdleCloserOptions): IdleCloser {
	const setTimer = opts.setTimer ?? setTimeout;
	const clearTimer = opts.clearTimer ?? clearTimeout;
	let timer: NodeJS.Timeout | undefined;
	const cancel = () => {
		if (timer !== undefined) {
			clearTimer(timer);
			timer = undefined;
		}
	};
	return {
		touch() {
			cancel();
			timer = setTimer(() => {
				timer = undefined;
				opts.close();
			}, opts.idleMs);
		},
		cancel,
	};
}

/** Process-global browser state, shared across extension module instances. */
interface SharedBrowserState {
	browser?: Browser;
	launching?: Promise<Browser>;
	lifecycleInstalled?: boolean;
	idle?: IdleCloser;
}

function sharedState(): SharedBrowserState {
	return processGlobal<SharedBrowserState>("pi:web-shared-browser", () => ({}));
}

/**
 * Parent dir for per-launch Chrome profiles. Each launch gets
 * its own subdir; a startup sweep removes the ones left behind
 * by a prior run that a SIGKILL or crash could not clean, which
 * is the orphan the clean-exit teardown never reclaims.
 */
const PROFILE_ROOT = path.join(os.tmpdir(), "pi-web-chrome");

/**
 * Find live pids whose argv still names `profileDir`. The path is
 * unique per pi pid, so a match is our orphaned Chrome and not an
 * innocent process that inherited a reused pid.
 */
function findProcsForProfile(profileDir: string): number[] {
	try {
		const out = execFileSync("ps", ["-eo", "pid=,command="], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		const pids: number[] = [];
		for (const line of out.split("\n")) {
			if (!line.includes(profileDir)) continue;
			const pid = Number.parseInt(line.trim(), 10);
			if (Number.isFinite(pid) && pid !== process.pid) pids.push(pid);
		}
		return pids;
	} catch {
		// No ps, or it failed; skip process reaping and just drop dirs.
		return [];
	}
}

/**
 * Reap Chrome trees and profile dirs left behind by a prior run.
 * A clean exit reclaims its own dir, so anything else under the
 * root belongs to a pi that a SIGKILL or crash could not clean up:
 * kill the orphaned Chrome group, then drop its dir.
 */
function reapOrphanProfiles(): void {
	reapOrphans({
		root: PROFILE_ROOT,
		currentPid: process.pid,
		listEntries: () => {
			try {
				return fs.readdirSync(PROFILE_ROOT);
			} catch {
				// No profile root yet; nothing to reap.
				return [];
			}
		},
		findProcs: findProcsForProfile,
		killPid: (pid) => killPidGroup(pid),
		removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
	});
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

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Launch headless Chrome once, against a freshly reset profile. */
async function launchOnce(): Promise<Browser> {
	const profileDir = path.join(PROFILE_ROOT, String(process.pid));
	// Reset the profile so a half-dead Chrome's SingletonLock from a
	// prior attempt cannot poison this one.
	fs.rmSync(profileDir, { recursive: true, force: true });
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
			// Route Chrome's own errors to stderr (at v=0, errors only) so
			// a failed launch carries a real reason. dumpio stays false, so
			// none of this reaches the user's terminal on success.
			"--enable-logging=stderr",
			"--v=0",
		],
		dumpio: false,
	});
}

/**
 * Launch Chrome with a bounded retry. A Chrome self-update on macOS
 * makes the first spawn exit before its DevTools endpoint appears;
 * the window is brief, so a short backoff usually rides it out. A
 * failed puppeteer.launch group-kills its own child, and each
 * attempt resets the profile, so retries never stack orphans.
 */
async function launchBrowser(): Promise<Browser> {
	installLifecycleHandlers();
	reapOrphanProfiles();
	let lastError: unknown;
	for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
		try {
			return await launchOnce();
		} catch (err) {
			lastError = err;
			// Chrome-not-found is a settled misconfig, not a transient; do
			// not burn retries or reshape its already-clear message.
			if (err instanceof Error && err.message.includes("Chrome not found")) {
				throw err;
			}
			const backoff = LAUNCH_BACKOFF_MS[attempt - 1];
			if (backoff !== undefined) await sleep(backoff);
		}
	}
	throw new BrowserLaunchFailed(
		classifyLaunchError(lastError),
		LAUNCH_ATTEMPTS,
	);
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
		idleCloser().touch();
		return state.browser;
	} finally {
		state.launching = undefined;
	}
}

/**
 * The idle-close countdown, created once per process. When it
 * fires it shuts the shared browser down; a later getBrowser
 * relaunches, which also picks up a Chrome that updated in the
 * meantime rather than reusing a version pinned hours ago.
 */
function idleCloser(): IdleCloser {
	const state = sharedState();
	if (!state.idle) {
		state.idle = createIdleCloser({
			idleMs: IDLE_TIMEOUT_MS,
			close: () => {
				void closeBrowser();
			},
		});
	}
	return state.idle;
}

/** Open a new browser tab with a standard user agent string. */
export async function newPage(): Promise<Page> {
	const b = await getBrowser();
	idleCloser().touch();
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
	// Wait out an in-flight launch so a browser that resolves after
	// close is not orphaned past the intended shutdown.
	if (state.launching) {
		try {
			await state.launching;
		} catch {
			// A failed launch leaves nothing to close.
		}
	}
	const b = state.browser;
	if (!b) return;

	state.idle?.cancel();
	try {
		if (b.connected) await b.close();
	} catch {
		// Graceful close failed. Kill the whole Chrome process group so
		// no helper (GPU, network, renderer) lingers as an orphan.
		killTree(b.process());
	} finally {
		state.browser = undefined;
		// Reclaim this run's profile dir on a graceful close rather
		// than leaving it for the next run's startup sweep.
		try {
			fs.rmSync(path.join(PROFILE_ROOT, String(process.pid)), {
				recursive: true,
				force: true,
			});
		} catch {
			// Best-effort cleanup; the next launch sweeps leftovers.
		}
	}
}

/**
 * Force-kill the Chrome process synchronously. Called from
 * `process.on('exit')` where async work isn't possible.
 */
export function killBrowserSync(): void {
	const state = sharedState();
	state.idle?.cancel();
	const b = state.browser;
	if (!b) return;

	// Group-kill so the helper tree dies with the leader instead of
	// reparenting to launchd.
	killTree(b.process());
	state.browser = undefined;
}
