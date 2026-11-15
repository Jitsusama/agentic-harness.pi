/**
 * Opening tabs in the shared Chrome: a plain tab, a tab in a context
 * of its own, a one-off read bounded by the caller and always
 * closed, and the claims that keep the process alive while a wait
 * outlives its tabs.
 *
 * Kept apart from the shared browser because tabs change with what
 * their readers need (a user agent, a cookie jar carried between
 * reads, a close that may not wedge), while the browser under them
 * only has to be there.
 */

import type {
	Browser,
	BrowserContext,
	CookieData,
	Page,
} from "puppeteer-core";
import { abortError, type Bounds, bounded } from "../bound.ts";
import { type CookieJar, cookieData } from "../jar.ts";
import {
	getBrowser,
	idleCloser,
	settleEventLoop,
	sharedState,
} from "./shared.ts";

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
