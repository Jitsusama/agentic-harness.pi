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

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import type {
	Browser,
	BrowserContext,
	CookieData,
	Page,
	Target,
} from "puppeteer-core";
import { processGlobal } from "../../internal/process-global.ts";
import { abortError, type Bounds, bounded } from "./bound.ts";
import { resolveChromePath } from "./chrome.ts";
import { CookieJar, cookieData } from "./jar.ts";
import { findProcsByProfile, verifyBrowser } from "./procs.ts";

export { namesProfile } from "./procs.ts";

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

/** What a process records about the Chrome it owns, written into its profile dir. */
export interface OwnerRecord {
	/** Pid of the owning process. */
	ownerPid: number;
	/** Pid (and process-group leader) of the Chrome this process launched. */
	browserPid?: number;
	/**
	 * The browser-wide DevTools WebSocket URL, when Chrome published one.
	 * A separate process passes this to connectShared() to attach to this
	 * same browser instead of launching its own. Absent when the port
	 * file never appeared or the DevTools HTTP endpoint never answered;
	 * either way the owning process's own pipe-based connection, which
	 * does not depend on this, is unaffected.
	 */
	browserWSEndpoint?: string;
}

/** Inputs for reaping Chrome trees and profile dirs a dead owner left behind. */
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
 * True when a profile's owning process is still running. Liveness is keyed
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
	const pid = owner ? owner.ownerPid : Number.parseInt(entry, 10);
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
 * dir is reaped only when its owning process is dead. The candidate kill
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
	const setTimer: (fn: () => void, ms: number) => NodeJS.Timeout =
		opts.setTimer ?? setTimeout;
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
	/** Count of holdWhile calls in flight, including a teardown's own. */
	claims?: number;
	/** Consumer tabs open in the current browser, seen since its launch. */
	tabs?: Set<Target>;
	/** The browser whose handles are ref'd right now, if any. */
	heldFor?: Browser;
	/** Cookies one-off reads carry between their contexts, per launch. */
	jar?: CookieJar;
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
		if (typeof rec?.ownerPid === "number") return rec;
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

/** Record who owns this profile, which Chrome pid it launched, and how a
 * separate process can reach that same browser. */
function writeOwnerRecord(
	profileDir: string,
	browserPid?: number,
	browserWSEndpoint?: string,
): void {
	const record: OwnerRecord = {
		ownerPid: process.pid,
		browserPid,
		browserWSEndpoint,
	};
	try {
		fs.writeFileSync(ownerFile(profileDir), JSON.stringify(record));
	} catch {
		// A missing record only downgrades a future reap to bare-pid
		// liveness, so a write failure is not worth failing the launch.
	}
}

/**
 * Reap Chrome trees and profile dirs left behind by a prior run.
 * A dir is reaped only when its owning process is provably dead, so a
 * live sibling process keeps its browser; the recorded Chrome pid is
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
 * Kill Chrome on the signals that would otherwise orphan it (SIGINT,
 * SIGTERM, SIGHUP), and on clean exit. A hard-killed subagent gets
 * SIGTERM, so this is what keeps the RELY01 orphan from accumulating.
 *
 * The exit is not ours to take. A host listening for the same signal
 * saves its state and restores the terminal there, and calling
 * `process.exit` first ends the process before it can; so with another
 * listener this only kills Chrome, and alone it raises the signal again
 * so the default, being killed by it, still happens.
 */
function installLifecycleHandlers(): void {
	const state = sharedState();
	if (state.lifecycleInstalled) return;
	state.lifecycleInstalled = true;
	process.once("exit", killBrowserSync);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			killBrowserSync();
			if (process.listenerCount(signal) === 0)
				process.kill(process.pid, signal);
		});
	}
}

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
 * Stop the warm browser from being the only reason this process
 * stays alive.
 *
 * The browser is kept between sessions so the next call does not
 * pay a second and a half to launch Chrome again. But its child
 * process, its stdio pipes and its DevTools socket all hold the
 * event loop, so a script that opened a session, did its work
 * and closed it sat there until the five-minute idle close fired
 * and only then exited. Measured: two and a half seconds of
 * work, three hundred and one seconds of wall clock, three and a
 * half seconds of CPU. Anything wiring this into CI would have
 * read that as a hang.
 *
 * unref does not close anything. The browser stays usable and
 * the idle close still runs; it just stops counting as a reason
 * to keep running. A session has its own handles and is
 * unaffected, and a script exits when its own work is done.
 */
export function releaseEventLoop(child: LoopHandle | null): void {
	if (!child) return;
	child.unref();
	for (const pipe of child.stdio) nudge(pipe, "unref");
}

/**
 * The part of a child process this cares about.
 *
 * stdio is left loose because a pipe's declared stream type does
 * not carry ref and unref even though a socket-backed one has
 * them, so each entry is asked rather than assumed.
 */
export interface LoopHandle {
	ref(): void;
	unref(): void;
	readonly stdio: readonly unknown[];
}

/** Ask a stdio entry to ref or unref itself, if it can. */
function nudge(pipe: unknown, how: "ref" | "unref"): void {
	if (typeof pipe !== "object" || pipe === null) return;
	const method = (pipe as Record<string, unknown>)[how];
	if (typeof method === "function") method.call(pipe);
}

/**
 * Keep the process alive for as long as a teardown needs.
 *
 * The inverse of releaseEventLoop. Closing a browser is several
 * round trips, and once nothing is ref'd Node is free to exit
 * in the middle of them, which leaves the caller's promise
 * hanging and Chrome to be reaped as an orphan next run.
 */
export function holdEventLoop(child: LoopHandle | null): void {
	if (!child) return;
	child.ref();
	for (const pipe of child.stdio) nudge(pipe, "ref");
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
		watchTabs(state, state.browser);
		// A fresh profile has none of the old one's cookies, so the
		// reads that share them start again too.
		state.jar = new CookieJar();
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

/** The user agent every tab we open presents. */
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
	"AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/131.0.0.0 Safari/537.36";

/** Open a new browser tab with a standard user agent string. */
export async function newPage(): Promise<Page> {
	return withLease(async (b) => {
		const page = await b.newPage();
		return dressPage(page);
	});
}

/**
 * Open a tab in a browser context of its own: separate
 * cookies, storage and cache from every other context in the
 * shared Chrome. Two sessions opened this way are two
 * genuinely independent users. Closing the context closes the
 * tabs inside it and leaves its siblings alone.
 */
export async function newContextPage(): Promise<{
	page: Page;
	context: BrowserContext;
}> {
	return withLease(async (b) => {
		const context = await b.createBrowserContext();
		try {
			const page = await dressPage(await context.newPage());
			return { page, context };
		} catch (err) {
			// Do not leave an empty context behind on a failed open.
			await context.close().catch(() => {});
			throw err;
		}
	});
}

/**
 * How long a one-off tab's close may take. Closing is one round trip
 * and normally takes tens of milliseconds; this only bites when Chrome
 * has stopped answering.
 */
const TAB_CLOSE_MS = 5_000;

/**
 * Do one piece of work in a tab of its own, bounded by the caller's
 * signal and a wall clock, and always close the tab afterwards.
 *
 * The tab gets a browser context of its own. Puppeteer's page.close
 * first waits for every screenshot in flight in the tab's context, so
 * in the one shared context a single wedged capture held up every
 * other read's close; in a context of its own it holds up nobody's.
 *
 * An abort ends the wait at once and reports itself as an abort. The
 * tab is closed in the background rather than waited for, since the
 * person has already moved on, and the loop stays held until that
 * close is done.
 */
export async function withTab<T>(
	bounds: Bounds,
	work: (page: Page) => Promise<T>,
): Promise<T> {
	if (bounds.signal?.aborted) throw abortError(bounds.signal);
	let tab: { page: Page; context: BrowserContext } | undefined;
	let seeded: { jar: CookieJar; cookies: CookieData[] } | undefined;
	let closing: Promise<void> | undefined;
	let abandoned = false;
	const close = (): Promise<void> => {
		if (!tab) return Promise.resolve();
		closing ??= closeContextWithin(tab.context, TAB_CLOSE_MS, seeded);
		return closing;
	};
	const run = (async () => {
		tab = await newContextPage();
		// Given up on while the tab was still opening: nobody is left
		// to use it.
		if (abandoned) {
			void close();
			throw abortError(bounds.signal);
		}
		seeded = await seedFromJar(tab.context);
		return work(tab.page);
	})();
	try {
		return await bounded(run, bounds, () => {
			abandoned = true;
			void close();
		});
	} finally {
		if (!abandoned) await close();
	}
}

/**
 * Close a context, but never wait longer than it deserves. A close
 * Chrome never answers leaves the context's tabs uncounted, so a
 * wedged tab cannot keep the process alive for the rest of its life.
 */
async function closeContextWithin(
	context: BrowserContext,
	ms: number,
	seeded?: { jar: CookieJar; cookies: CookieData[] },
): Promise<void> {
	try {
		await holdWhile(() =>
			bounded(
				(async () => {
					if (seeded) await handBackToJar(context, seeded);
					await context.close();
				})(),
				{ wallMs: ms, what: "closing a tab" },
			),
		);
	} catch {
		// Given up on, or already gone with its browser. Either way
		// there is nothing left to wait for.
		forgetContext(context);
	}
}

/**
 * Start a reading context with the cookies earlier reads left, and
 * say what it was given so its changes can be told apart later.
 */
async function seedFromJar(
	context: BrowserContext,
): Promise<{ jar: CookieJar; cookies: CookieData[] } | undefined> {
	const jar = sharedState().jar;
	if (!jar) return undefined;
	const cookies = jar.contents();
	if (cookies.length === 0) return { jar, cookies };
	try {
		await context.setCookie(...cookies);
		return { jar, cookies };
	} catch {
		// Carrying cookies over is a nicety, never a reason to fail
		// a read. The context was given nothing, so say so, and none
		// of the jar is taken as removed when it ends without them.
		return { jar, cookies: [] };
	}
}

/**
 * Give the jar what a reading context changed. Only ever a nicety:
 * a context that cannot be read is closed all the same.
 */
async function handBackToJar(
	context: BrowserContext,
	seeded: { jar: CookieJar; cookies: CookieData[] },
): Promise<void> {
	try {
		const ended = (await context.cookies()).map(cookieData);
		seeded.jar.absorb(seeded.cookies, ended);
	} catch {
		// The browser went away under us; its cookies went with it.
	}
}

/** Stop counting a context's tabs as work in flight. */
function forgetContext(context: BrowserContext): void {
	const state = sharedState();
	for (const target of state.tabs ?? []) {
		if (target.browserContext() === context) state.tabs?.delete(target);
	}
	settleEventLoop(state);
}

/** Give a fresh tab the user agent we present everywhere. */
async function dressPage(page: Page): Promise<Page> {
	try {
		await page.setUserAgent(USER_AGENT);
	} catch (err) {
		await page.close();
		throw err;
	}
	return page;
}

/**
 * Run an acquisition against the shared browser while holding
 * a lease, so an idle close firing concurrently sees the
 * in-flight work and defers instead of pulling Chrome out from
 * under it.
 */
async function withLease<T>(
	acquire: (browser: Browser) => Promise<T>,
): Promise<T> {
	const state = sharedState();
	// Reserve the lease synchronously, before any await.
	state.pending = (state.pending ?? 0) + 1;
	settleEventLoop(state);
	try {
		const b = await getBrowser();
		idleCloser().touch();
		return await acquire(b);
	} finally {
		state.pending = (state.pending ?? 1) - 1;
		settleEventLoop(state);
	}
}

/**
 * Keep the process alive while some work waits on the browser
 * with no tab of its own open.
 *
 * An open tab already holds the loop, and so does a page
 * acquisition. What neither covers is a wait that outlives the
 * tabs it concerns. Closing a browser context is the one that
 * matters: Chrome reports the context's tabs destroyed before it
 * answers the call that disposed it, so the answer would arrive
 * with nothing holding the loop, and a script with nothing else
 * to do exits waiting for it.
 */
export async function holdWhile<T>(work: () => Promise<T>): Promise<T> {
	const state = sharedState();
	state.claims = (state.claims ?? 0) + 1;
	settleEventLoop(state);
	try {
		return await work();
	} finally {
		state.claims = (state.claims ?? 1) - 1;
		settleEventLoop(state);
	}
}

/**
 * Count the consumer tabs a freshly launched browser opens from
 * here on. Watching starts after launch, so the blank tab
 * puppeteer opens with the browser is never counted: an idle
 * browser holds nothing.
 *
 * A tab counts until its Page reports closed, not until its
 * target is destroyed. Puppeteer's page.close goes on waiting
 * after the target is gone, for the tab's parent target, which
 * the browser never announces, and letting go at the destroyed
 * event left that wait with nothing behind it. The Page's close
 * event fires off the very promise page.close awaits, so the
 * caller's continuation runs before the loop can go idle, and
 * whatever it starts next takes its own hold.
 *
 * A freshly spawned child holds the loop, so the browser starts
 * out held and is let go by the settle that follows, unless a
 * lease is already waiting on it.
 */
function watchTabs(state: SharedBrowserState, browser: Browser): void {
	const tabs = new Set<Target>();
	state.tabs = tabs;
	state.heldFor = browser;
	const forget = (target: Target): void => {
		if (tabs.delete(target)) settleEventLoop(state);
	};
	browser.on("targetcreated", (target: Target) => {
		if (target.type() !== "page") return;
		tabs.add(target);
		settleEventLoop(state);
		target.page().then(
			(page) => {
				if (!page || page.isClosed()) forget(target);
				else page.once("close", () => forget(target));
			},
			// A tab that closed before it could be read has nothing
			// left to wait on.
			() => forget(target),
		);
	});
	browser.on("disconnected", () => {
		tabs.clear();
		settleEventLoop(state);
	});
	settleEventLoop(state);
}

/**
 * Hold the event loop exactly while something waits on the
 * browser, and let it go the moment nothing does.
 *
 * The browser is kept warm between uses, and an idle one must not
 * keep a finished script running (see releaseEventLoop). But
 * Chrome's pipes carry every answer puppeteer waits for, so while
 * work is in flight they are the reason to stay alive. Letting go
 * for good at launch meant a web_read or web_search with nothing
 * else ref'd exited mid-load with code 13 and no answer.
 *
 * Demand is what is in flight: page acquisitions, open consumer
 * tabs, and holdWhile claims, a teardown's among them.
 */
function settleEventLoop(state: SharedBrowserState): void {
	const browser = state.browser;
	if (!browser) return;
	const demand =
		(state.pending ?? 0) + (state.claims ?? 0) + (state.tabs?.size ?? 0);
	const held = state.heldFor === browser;
	if (demand > 0 && !held) {
		holdEventLoop(browser.process());
		state.heldFor = browser;
	} else if (demand === 0 && held) {
		releaseEventLoop(browser.process());
		state.heldFor = undefined;
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
	// Take the handles back before tearing down. They are unref'd
	// while the browser sits warm, so that a finished script is not
	// held open by a browser nobody is using; but a close in
	// progress is work worth staying alive for, and without this
	// Node exited mid-teardown and the caller's await never
	// settled. It is a claim rather than a bare hold, so the tabs
	// the close destroys cannot settle the loop back to released
	// halfway through.
	const pid = proc?.pid;
	const dir = ownProfileDir();
	let closedGracefully = false;
	state.claims = (state.claims ?? 0) + 1;
	settleEventLoop(state);
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
		state.tabs = undefined;
		state.heldFor = undefined;
		state.claims = (state.claims ?? 1) - 1;
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
	state.tabs = undefined;
	state.heldFor = undefined;
}
