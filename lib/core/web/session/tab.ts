/**
 * Which tab the session drives, and keeping it alive: binding every
 * watcher to a tab, replacing one that crashed, waiting out that
 * replacement before any call touches the page, and switching to
 * another tab the page opened.
 *
 * Kept apart from the session because recovering from a crash and
 * switching tabs are one piece of code, and it changes with how
 * Chrome announces a dead renderer rather than with anything a
 * caller asks of the page.
 */

import type { CDPSession, Page } from "puppeteer-core";
import { holdWhile } from "../browser.ts";
import { chooseTab, type TabRecord } from "../environment/index.ts";
import { diedWithTheTab, failureText, wasAborted } from "../telemetry/index.ts";
import type { EmulationController } from "./emulation.ts";
import type { SourceMapStore } from "./sourcemaps.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import type { SessionWires } from "./wires.ts";

/**
 * How long to give Chrome to announce a crash that has already
 * broken a call, and how often to look for the announcement.
 *
 * Only spent on a call that has just failed with the tab dying
 * underneath it, so the wait is never on the healthy path. The
 * announcement arrives in milliseconds; the budget is generous
 * because the alternative to waiting is losing the call.
 */
const CRASH_NOTICE_BUDGET_MS = 2000;
const CRASH_NOTICE_POLL_MS = 25;

/**
 * How long a tab has to answer whether it lives, after an abort.
 *
 * A live tab answers in a millisecond or two and a dead one is
 * refused as closed within 20 ms, as measured on 12 November. A tab
 * busy in a long script answers only once it is free, so past this
 * it counts as alive and the abort stands.
 */
const ALIVE_BUDGET_MS = 500;

/** What keeping a tab needs of the session it belongs to. */
export interface TabParts {
	/** Make this the session's tab and channel from now on. */
	readonly adopt: (page: Page, cdp: CDPSession) => void;
	/** The watchers a fresh tab has to be given again. */
	readonly telemetry: SessionTelemetry;
	/** The source maps a fresh tab has to be listened to for. */
	readonly sourceMaps: SourceMapStore;
	/** What the session pretends, put back on a fresh tab. */
	readonly emulation: EmulationController;
}

/** The session's one tab, bound, recovered and switched. */
export class SessionTab {
	/** The recovery in flight, so nothing reads a tab mid-replacement. */
	private recovery?: Promise<void>;

	/** Wall clock time of the last operation. See ready(). */
	private usedAt = Date.now();

	/** The live view of the browser the tab belongs to. */
	private readonly wires: SessionWires;

	/** Make this the session's tab and channel from now on. */
	private readonly hooks: Pick<TabParts, "adopt">;

	/** The watchers a fresh tab has to be given again. */
	private readonly telemetry: SessionTelemetry;

	/** The source maps a fresh tab has to be listened to for. */
	private readonly sourceMaps: SourceMapStore;

	/** What the session pretends, put back on a fresh tab. */
	private readonly emulation: EmulationController;

	constructor(wires: SessionWires, parts: TabParts) {
		this.wires = wires;
		this.hooks = { adopt: parts.adopt };
		this.telemetry = parts.telemetry;
		this.sourceMaps = parts.sourceMaps;
		this.emulation = parts.emulation;
	}

	/**
	 * Replace the dead tab with a live one.
	 *
	 * The context survives a tab crash and can still make pages,
	 * so the session keeps its identity, its cookies and every
	 * buffer it has filled; only the tab is new. Watchers have to
	 * be reinstalled because they were bound to a protocol channel
	 * that no longer answers.
	 */
	startRecovery(): Promise<void> {
		const recovery = this.recover();
		// A crash usually lands between calls, so nothing awaits this
		// until the next one arrives. A replacement that cannot be made
		// would be an unhandled rejection meanwhile, and in a host with
		// no handler for one, pi among them, that ends the process.
		// Whoever awaits it later still sees the failure.
		recovery.catch(() => {});
		this.recovery = recovery;
		return recovery;
	}

	private async recover(): Promise<void> {
		// The dead page will not answer, but closing it does work,
		// and leaving it would leak a renderer for the session's life.
		// Between the old tab closing and the new one opening the
		// session has no tab holding the event loop, so it claims one.
		await holdWhile(async () => {
			await this.wires
				.page()
				.close()
				// The dead page may never answer its close, which still frees it.
				.catch(() => {});
			await this.bindTo(await this.wires.context().newPage());
		});
	}

	/**
	 * Point the session at a tab and make it whole again.
	 *
	 * Every watcher is bound to one tab's protocol channel, so a
	 * session that changes tabs without reinstalling them goes on
	 * answering while quietly deaf to everything the new tab does.
	 * That is the same wound a crash leaves, which is why recovering
	 * from a crash and switching tabs are one piece of code: two
	 * copies would drift, and the half that drifted would fail
	 * silently in exactly this way.
	 */
	private async bindTo(page: Page): Promise<void> {
		const cdp = await page.createCDPSession();
		this.hooks.adopt(page, cdp);

		await cdp.send("Accessibility.enable");
		await cdp.send("DOM.enable");
		await cdp.send("CSS.enable");
		await this.telemetry.listenForAnnouncements();
		await this.telemetry.listenForLogs();
		await this.telemetry.listenForRequests();
		await this.telemetry.listenForDialogs();
		// Every listener open() installs has to come back, or the
		// session goes on answering while quietly deaf to part of
		// what the page does. Downloads and source maps were the two
		// that did not, so after a crash a file the page handed back
		// went unrecorded and a cascade trace lost its authored
		// positions, with nothing anywhere saying why.
		await this.telemetry.listenForDownloads();
		await this.sourceMaps.listen();

		// A fresh tab knows nothing of what the old one was
		// pretending, so the standing intent is put back before
		// anything reads from it.
		await this.emulation.apply();

		const { frameTree } = await cdp.send("Page.getFrameTree");
		this.telemetry.readoptLifecycle(frameTree.frame.id);
	}

	/**
	 * Whether the tab died under a call that failed with `failure`.
	 *
	 * A detached frame says so. An abort doesn't: a renderer killed
	 * outright, as the OOM killer kills one, aborts the navigation it
	 * was loading before Chrome announces the crash, about half the
	 * time when measured. So an abort asks the tab, and only a tab
	 * refused as closed counts as dead. One that answers is alive, so
	 * an abort the page itself caused stands and isn't retried.
	 */
	async tabDiedUnder(failure: string): Promise<boolean> {
		if (diedWithTheTab(failure)) return true;
		if (!wasAborted(failure)) return false;
		const asked = this.wires
			.cdp()
			.send("Runtime.evaluate", { expression: "0" })
			.then(
				() => false,
				(error: unknown) => diedWithTheTab(failureText(error)),
			);
		let timer: NodeJS.Timeout | undefined;
		const busy = new Promise<boolean>((answer) => {
			timer = setTimeout(() => answer(false), ALIVE_BUDGET_MS);
		});
		try {
			return await Promise.race([asked, busy]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Wait for the replacement tab, when one is coming.
	 *
	 * The crash announcement that starts a recovery can arrive
	 * after the failure it caused, so asking whether a recovery is
	 * under way immediately gets the wrong answer. This gives the
	 * announcement its moment and then waits the recovery out,
	 * reporting whether there was one, so a caller that died for
	 * some other reason is not left waiting on a tab nobody is
	 * replacing.
	 */
	async awaitReplacement(): Promise<boolean> {
		const deadline = Date.now() + CRASH_NOTICE_BUDGET_MS;
		while (!this.recovery && Date.now() < deadline) {
			await new Promise((wake) => setTimeout(wake, CRASH_NOTICE_POLL_MS));
		}
		if (!this.recovery) return false;
		try {
			await this.recovery;
		} catch {
			// No replacement came, so the caller answers with the failure
			// that sent it here; the next call tries to make the tab again.
			return false;
		}
		return true;
	}

	/**
	 * Wait for any recovery to finish.
	 *
	 * Called before anything that touches the tab, so a read that
	 * arrives during a crash waits for the replacement instead of
	 * hanging on a renderer that is never coming back.
	 */
	async ready(): Promise<void> {
		// Every operation passes through here, which makes it the one
		// honest place to record that the session is being used. The
		// registry reaps on idleness, and it used to measure that
		// from when a call started rather than from the last thing
		// the session did, so a health sweep or a long wait could
		// have the browser closed out from under it mid-call.
		this.usedAt = Date.now();
		if (!this.recovery) return;
		try {
			await this.recovery;
		} catch {
			// The last attempt to replace the tab failed. Kept as the
			// answer, it failed every call for the rest of the session,
			// so each call tries once more and this attempt's failure,
			// if it fails too, is that call's answer.
			await this.startRecovery();
		}
	}

	/** When this session last did anything, for the idle reaper. */
	get lastUsedAt(): number {
		return this.usedAt;
	}

	/**
	 * Every tab this session's context is holding open.
	 *
	 * A page that opens another one is doing something ordinary: a
	 * target of _blank, a sign-in or a payment handed to a second
	 * window. Until this existed the new tab was real, live and
	 * entirely invisible, and the click that made it looked like a
	 * click that did nothing.
	 */
	async tabs(): Promise<readonly TabRecord[]> {
		await this.ready();
		const pages = await this.wires.context().pages();
		return await Promise.all(
			pages.map(async (page, at) => ({
				index: at + 1,
				url: page.url(),
				// A tab still loading has no title yet, and asking a closing
				// one throws. Either way the url still identifies it, which
				// is what the caller picks by.
				title: await page.title().catch(() => ""),
				current: page === this.wires.page(),
			})),
		);
	}

	/**
	 * Drive a different tab from now on.
	 *
	 * The tab left behind is not closed. A sign-in that opened a
	 * second window usually wants the first one back afterwards, and
	 * closing it would make switching a one-way trip.
	 */
	async switchTab(index: number): Promise<TabRecord | { refusal: string }> {
		const open = await this.tabs();
		const chosen = chooseTab(open, index);
		if ("refusal" in chosen) return chosen;

		const pages = await this.wires.context().pages();
		const page = pages[chosen.index - 1];
		if (page === undefined) {
			return {
				refusal: `Tab ${index} closed between being listed and being chosen.`,
			};
		}
		if (page === this.wires.page()) return { ...chosen, current: true };

		await page.bringToFront();
		await this.bindTo(page);
		return { ...chosen, current: true };
	}
}
