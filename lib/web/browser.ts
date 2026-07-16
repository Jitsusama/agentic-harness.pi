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
import * as crypto from "node:crypto";
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
	fallback?: string,
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
	// When the failure is not a parseable Chrome exit (an EACCES or
	// ENOSPC from the profile, say), keep the raw reason rather than
	// discarding it behind the generic hint.
	else if (fallback) lines.push("", fallback);
	return lines.join("\n");
}

/** Thrown when Chrome could not be launched after the retry budget. */
export class BrowserLaunchFailed extends Error {
	readonly exitCode?: number;
	readonly chromeStderr?: string;
	constructor(cause: unknown, attempts: number) {
		const info = classifyLaunchError(cause);
		const fallback = cause instanceof Error ? cause.message : String(cause);
		super(formatLaunchFailure(info, attempts, fallback));
		this.name = "BrowserLaunchFailed";
		this.exitCode = info.exitCode;
		this.chromeStderr = info.chromeStderr;
		this.cause = cause;
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

/** What a pi records about the Chrome it owns, written into its profile dir. */
export interface OwnerRecord {
	/** Pid of the owning pi process. */
	piPid: number;
	/** Pid (and process-group leader) of the Chrome this pi launched. */
	browserPid?: number;
}

/** Inputs for reaping Chrome trees and profile dirs a dead pi left behind. */
export interface ReapOrphansOptions {
	root: string;
	listEntries: () => string[];
	readOwner: (profileDir: string) => OwnerRecord | undefined;
	isPidAlive: (pid: number) => boolean;
	verifyBrowser: (pid: number, profileDir: string) => boolean;
	/** Pids naming this exact profile, or undefined when the probe failed. */
	findProcsByProfile: (profileDir: string) => number[] | undefined;
	killPid: (pid: number) => void;
	removeDir: (dir: string) => void;
}

/**
 * True when a profile's owning pi is still running. Liveness is keyed
 * on the pid alone: a generation-unique profile directory means a
 * reused pid can never collide with a live owner's directory, so a
 * pid that is alive is treated as the owner and kept. This fails
 * closed, a reused pid only ever leaks a stale directory rather than
 * killing a live browser.
 */
function ownerAlive(
	opts: ReapOrphansOptions,
	entry: string,
	owner: OwnerRecord | undefined,
): boolean {
	const pid = owner ? owner.piPid : Number.parseInt(entry, 10);
	return Number.isFinite(pid) && opts.isPidAlive(pid);
}

/** True when a probe reports the pid still names this exact profile. */
function stillOurs(
	opts: ReapOrphansOptions,
	pid: number,
	dir: string,
): boolean {
	try {
		return opts.verifyBrowser(pid, dir);
	} catch {
		// Cannot confirm, so treat it as still present and fail safe.
		return true;
	}
}

/**
 * Reap Chrome trees and profile dirs a prior run left behind. Each
 * dir is reaped only when its owning pi is dead. The candidate kill
 * set is the exact-profile matches unioned with a recorded pid; each
 * candidate is re-verified immediately before it is signalled, so a
 * pid that exited and was reused is never group-killed. The dir is
 * removed only once discovery has run and a fresh check confirms no
 * candidate still names it, so a failed probe or a surviving process
 * keeps the dir for a later sweep. Every step is best-effort: one bad
 * entry can never abort the sweep or block a launch.
 */
export function reapOrphans(opts: ReapOrphansOptions): void {
	for (const entry of opts.listEntries()) {
		try {
			const dir = path.join(opts.root, entry);
			let owner: OwnerRecord | undefined;
			try {
				owner = opts.readOwner(dir);
			} catch {
				// Unreadable record; treat as no record.
			}
			if (ownerAlive(opts, entry, owner)) continue;

			const discovered = opts.findProcsByProfile(dir);
			const candidates = new Set<number>(discovered ?? []);
			if (owner?.browserPid) candidates.add(owner.browserPid);
			for (const pid of candidates) {
				// Re-verify at signalling time: a stale discovery entry or a
				// pid that has since been reused must not be group-killed.
				if (!stillOurs(opts, pid, dir)) continue;
				try {
					opts.killPid(pid);
				} catch {
					// Lost a race with the process exiting; a later sweep
					// reclaims the dir.
				}
			}

			// Remove the dir only when discovery ran and nothing we targeted
			// still names the profile. A failed probe or a survivor keeps it.
			if (discovered === undefined) continue;
			const cleared = [...candidates].every(
				(pid) => !stillOurs(opts, pid, dir),
			);
			if (!cleared) continue;
			try {
				opts.removeDir(dir);
			} catch {
				// A busy or unreadable dir must not block launches; the next
				// startup sweeps whatever this one could not.
			}
		} catch {
			// Defensive: never let one entry abort the whole sweep.
		}
	}
}

/**
 * Puppeteer opens one blank page on launch, so a browser with no
 * consumer page open sits at this count. A higher count means work
 * is in flight.
 */
const INITIAL_PAGE_COUNT = 1;

/** Decide whether an idle browser is truly unused and safe to close. */
export function shouldCloseWhenIdle(openPageCount: number): boolean {
	return openPageCount <= INITIAL_PAGE_COUNT;
}

/**
 * Decide whether teardown should force-kill the browser process group.
 * Never after a clean graceful close, since the pid is already gone and
 * could be reused; only when the close did not happen and the process
 * still verifies as our Chrome.
 */
export function shouldForceKill(
	closedGracefully: boolean,
	stillVerifies: boolean,
): boolean {
	return !closedGracefully && stillVerifies;
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
			// A pending idle close must not, by itself, hold the event loop
			// open and delay process exit.
			(timer as { unref?: () => void }).unref?.();
		},
		cancel,
	};
}

/** Process-global browser state, shared across extension module instances. */
interface SharedBrowserState {
	browser?: Browser;
	launching?: Promise<Browser>;
	closing?: Promise<void>;
	/** Count of page acquisitions in flight, so an idle close defers to them. */
	pending?: number;
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
 * This process's own profile directory, resolved once and shared
 * across extension module instances. The name carries a random
 * generation nonce alongside the pid, so a reused pid can never
 * collide with a previous run's directory and the reaper can treat
 * a live pid as its owner without a fragile start-time probe.
 */
function ownProfileDir(): string {
	return processGlobal("pi:web-chrome-profile", () =>
		path.join(
			PROFILE_ROOT,
			`${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
		),
	);
}

/** The ownership record path inside a profile dir. */
function ownerFile(profileDir: string): string {
	return path.join(profileDir, "owner.json");
}

/** Read a profile's ownership record, or undefined if absent or unreadable. */
function readOwnerRecord(profileDir: string): OwnerRecord | undefined {
	try {
		const raw = fs.readFileSync(ownerFile(profileDir), "utf8");
		const rec = JSON.parse(raw);
		if (typeof rec?.piPid === "number") return rec;
	} catch {
		// No record, or malformed; the caller treats this as no record.
	}
	return undefined;
}

/** True when a pid names a live process (EPERM still means it exists). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Confirm a single pid is still the Chrome we launched for `profileDir`,
 * by matching its --user-data-dir argument exactly. This guards the
 * kill against a reused pid now owned by an unrelated process.
 */
function verifyBrowser(pid: number, profileDir: string): boolean {
	try {
		const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
		});
		return namesProfile(cmd, profileDir);
	} catch {
		return false;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `command` carries this exact profile as its
 * --user-data-dir. Both sides of the value are anchored, so neither a
 * longer sibling path nor a differently-prefixed flag can collide.
 */
export function namesProfile(command: string, profileDir: string): boolean {
	return new RegExp(
		`(?:^|\\s)--user-data-dir=${escapeRegExp(profileDir)}(?:\\s|$)`,
	).test(command);
}

/**
 * Pids that still name `profileDir` as their --user-data-dir, matched
 * as an exact argument so a longer sibling path never collides. Used
 * only to rediscover an orphan whose owner is already proven dead.
 */
function findProcsByProfile(profileDir: string): number[] | undefined {
	try {
		const out = execFileSync("ps", ["-eo", "pid=,command="], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		const pids: number[] = [];
		for (const line of out.split("\n")) {
			if (!namesProfile(line, profileDir)) continue;
			const pid = Number.parseInt(line.trim(), 10);
			if (Number.isFinite(pid) && pid !== process.pid) pids.push(pid);
		}
		return pids;
	} catch {
		// The probe itself failed: signal "unknown", not "none", so a
		// still-running orphan is not mistaken for an empty result.
		return undefined;
	}
}

/** This pi's own start-time token, resolved once. */
/** Record who owns this profile and which Chrome pid it launched. */
function writeOwnerRecord(profileDir: string, browserPid?: number): void {
	const record: OwnerRecord = { piPid: process.pid, browserPid };
	try {
		fs.writeFileSync(ownerFile(profileDir), JSON.stringify(record));
	} catch {
		// A missing record only downgrades a future reap to bare-pid
		// liveness, so a write failure is not worth failing the launch.
	}
}

/**
 * Reap Chrome trees and profile dirs left behind by a prior run.
 * A dir is reaped only when its owning pi is provably dead, so a
 * live sibling pi keeps its browser; the recorded Chrome pid is
 * killed only after an exact re-verify.
 */
function reapOrphanProfiles(): void {
	reapOrphans({
		root: PROFILE_ROOT,
		listEntries: () => {
			try {
				return fs.readdirSync(PROFILE_ROOT);
			} catch {
				// No profile root yet; nothing to reap.
				return [];
			}
		},
		readOwner: readOwnerRecord,
		isPidAlive,
		verifyBrowser,
		findProcsByProfile,
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
async function launchOnce(executablePath: string): Promise<Browser> {
	const profileDir = ownProfileDir();
	// Reset the profile so a half-dead Chrome's SingletonLock from a
	// prior attempt cannot poison this one.
	fs.rmSync(profileDir, { recursive: true, force: true });
	fs.mkdirSync(profileDir, { recursive: true });
	const browser = await puppeteer.launch({
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
 * attempt resets the profile, so retries never stack orphans.
 */
async function launchBrowser(): Promise<Browser> {
	installLifecycleHandlers();
	reapOrphanProfiles();
	// Resolve the binary once, before the loop. A missing Chrome is a
	// settled misconfig, not a transient, so it throws its own clear
	// error immediately instead of being retried or sniffed for by
	// message text.
	const executablePath = process.env.CHROME_PATH || findChrome();
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

/**
 * Get the shared headless Chrome instance, launching it if
 * needed. Concurrent callers share one in-flight launch, so two
 * extensions reaching for the browser in the same tick do not
 * race two Chrome processes onto the same profile.
 */
export async function getBrowser(): Promise<Browser> {
	const state = sharedState();
	// Wait out an in-flight teardown so we never hand back a browser that
	// is closing, nor race a relaunch against its profile removal.
	if (state.closing) await state.closing;
	if (state.browser?.connected) return state.browser;
	// A browser that exists but has disconnected is stale: retire it (and
	// its still-running process) before launching a replacement.
	if (state.browser) await closeBrowser();
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
				void closeIfUnused();
			},
		});
	}
	return state.idle;
}

/**
 * The idle timer fired. Close only if no consumer page is open;
 * otherwise a session or in-flight read is still using the browser,
 * so rearm the countdown instead of closing under it.
 */
async function closeIfUnused(): Promise<void> {
	const state = sharedState();
	const b = state.browser;
	if (b?.connected) {
		try {
			const pages = await b.pages();
			if (!shouldCloseWhenIdle(pages.length)) {
				idleCloser().touch();
				return;
			}
		} catch {
			// Could not read pages; fall through to the pending check.
		}
	}
	// A page acquisition may have started during the async pages read.
	// This check and closeBrowser's synchronous prologue (which sets
	// state.closing) run with no await between them, so a newPage that
	// reserved a lease either is seen here or waits on state.closing.
	if ((state.pending ?? 0) > 0) {
		idleCloser().touch();
		return;
	}
	await closeBrowser();
}

/** Open a new browser tab with a standard user agent string. */
export async function newPage(): Promise<Page> {
	const state = sharedState();
	// Reserve a lease synchronously, before any await, so an idle close
	// firing concurrently sees the in-flight acquisition and defers.
	state.pending = (state.pending ?? 0) + 1;
	try {
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
	} finally {
		state.pending = (state.pending ?? 1) - 1;
	}
}

/** Shut down the shared Chrome instance if it's running. */
export async function closeBrowser(): Promise<void> {
	const state = sharedState();
	// One teardown at a time: a second caller (say the idle timer and an
	// explicit close) awaits the same operation rather than racing it.
	if (state.closing) return state.closing;
	state.closing = runClose(state);
	try {
		await state.closing;
	} finally {
		state.closing = undefined;
	}
}

async function runClose(state: SharedBrowserState): Promise<void> {
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
	const proc = b.process();
	const pid = proc?.pid;
	const dir = ownProfileDir();
	let closedGracefully = false;
	try {
		if (b.connected) {
			await b.close();
			closedGracefully = true;
		}
	} catch {
		// Graceful close failed; the force-kill below handles it.
	} finally {
		// Force-kill only when we did not cleanly close (a disconnected or
		// close-failed browser), and only while the pid still verifies as
		// our Chrome. After a clean close the pid is gone and could be
		// reused, so signalling its group would be unsafe.
		if (
			shouldForceKill(closedGracefully, pid ? verifyBrowser(pid, dir) : false)
		) {
			killTree(proc);
		}
		state.browser = undefined;
		// Reclaim the profile only once the process is gone: a clean close,
		// or a post-teardown check that no longer finds it. Otherwise keep
		// the dir so the next run's reaper still has a handle to a survivor.
		const gone = closedGracefully || !pid || !verifyBrowser(pid, dir);
		if (gone) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; the next launch sweeps leftovers.
			}
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
	// reparenting to launchd, but only for a process we can still confirm
	// is ours by its exact profile, so neither a stale CDP connection nor
	// a crashed-and-reused pid is ever signalled. Reclaim the dir only
	// when it was ours to kill; otherwise leave it for the next reaper.
	const proc = b.process();
	const pid = proc?.pid;
	const dir = ownProfileDir();
	if (pid && verifyBrowser(pid, dir)) {
		killTree(proc);
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort; a later run's reaper removes whatever remains.
		}
	}
	state.browser = undefined;
}
