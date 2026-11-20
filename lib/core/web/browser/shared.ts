/**
 * The one Chrome a process shares: launching it once for every
 * caller, holding the event loop exactly while work waits on it,
 * closing it when idle, and killing it on the way out.
 *
 * The state lives on globalThis rather than in a module variable,
 * because pi loads each extension as its own module instance (see
 * browser.ts). Kept apart from the tabs because this is the
 * browser's lifetime, which changes with how processes and Chrome
 * behave, while what a tab is dressed in and how long its close may
 * take change with the readers that open them.
 */

import * as fs from "node:fs";
import type { Browser, Target } from "puppeteer-core";
import { processGlobal } from "../../../internal/process/process-global.ts";
import { CookieJar } from "../jar.ts";
import { verifyBrowser } from "../procs.ts";
import {
	createIdleCloser,
	type IdleCloser,
	shouldCloseWhenIdle,
	shouldForceKill,
} from "./idle.ts";
import { launchChrome } from "./launch.ts";
import { holdEventLoop, releaseEventLoop } from "./loop.ts";
import { ownProfileDir } from "./profile.ts";
import { killTree } from "./reaping.ts";

/** Close the shared browser after this long with no new page opened. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Process-global browser state, shared across extension module instances. */
export interface SharedBrowserState {
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

export function sharedState(): SharedBrowserState {
	return processGlobal<SharedBrowserState>("pi:web-shared-browser", () => ({}));
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

/** Launch the shared Chrome, its teardown handlers installed first. */
async function launchBrowser(): Promise<Browser> {
	installLifecycleHandlers();
	return await launchChrome();
}

/**
 * Whether a browser answers DevTools over its pipe alone. One launched
 * before the port was dropped was started without the flag.
 */
export function keepsToThePipe(browser: Browser): boolean {
	const args = browser.process()?.spawnargs ?? [];
	return (
		args.includes("--remote-debugging-pipe") &&
		!args.some((arg) => arg.startsWith("--remote-debugging-port"))
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
	// Wait out an in-flight teardown so we never hand back a browser that
	// is closing, nor race a relaunch against its profile removal.
	if (state.closing) await state.closing;
	if (state.browser?.connected && keepsToThePipe(state.browser))
		return state.browser;
	// A browser that exists but has disconnected is stale: retire it (and
	// its still-running process) before launching a replacement. So is one
	// an older harness launched with a DevTools port, which outlives a
	// reload on this process-global and would keep the port open.
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
export function idleCloser(): IdleCloser {
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
export function settleEventLoop(state: SharedBrowserState): void {
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
