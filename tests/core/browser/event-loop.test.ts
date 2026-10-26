/**
 * Whether the warm browser keeps this process alive, and when.
 *
 * Idle, it must not: a script that finished its work would otherwise
 * sit until the idle close fired. Busy, it must: Chrome's pipes carry
 * every answer puppeteer is waiting for, and with nothing else ref'd
 * Node exits in the middle of the wait. That is how a web_read or a
 * web_search in print mode ended with exit code 13 and no answer, and
 * how a subagent lost its result.
 *
 * The loop is observed through process.getActiveResourcesInfo, which
 * lists only the handles holding it. Chrome's child process is the one
 * entry the browser adds, so the count of process handles says whether
 * the browser is holding the loop.
 */

import type { Page, Target } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	closeBrowser,
	getBrowser,
	newPage,
} from "../../../lib/core/web/browser.ts";
import { BrowserSession } from "../../../lib/core/web/session.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HELLO = page("Hello", "<main><h1>Hello</h1></main>");

/** How many child processes are holding the event loop open. */
function heldChildren(): number {
	return process
		.getActiveResourcesInfo()
		.filter((resource) => resource === "ProcessWrap").length;
}

let fixture: Fixture;

describe.skipIf(!haveChrome)("the warm browser and the event loop", () => {
	beforeAll(async () => {
		fixture = await serve([{ path: "/hello", body: HELLO }]);
	});

	afterAll(async () => {
		await closeBrowser();
		await fixture?.close();
	});

	it("lets go of the loop while the browser sits idle", async () => {
		const before = heldChildren();

		await getBrowser();

		expect(heldChildren()).toBe(before);
	});

	it("holds the loop while a tab is open and lets go once it closes", async () => {
		// A tab's target is destroyed before puppeteer's close has
		// finished: it goes on to wait for the tab's parent target,
		// whose own message comes later. So the hold has to outlast
		// the destroyed event, or that wait has nothing behind it.
		const idle = heldChildren();
		const browser = await getBrowser();
		const atDestroyed: number[] = [];
		const sample = (): void => {
			atDestroyed.push(heldChildren());
		};

		const tab = await newPage();
		const whileOpen = heldChildren();
		await tab.goto(fixture.url("/hello"));
		const whileLoaded = heldChildren();
		browser.on("targetdestroyed", sample);
		try {
			await tab.close();
		} finally {
			browser.off("targetdestroyed", sample);
		}

		expect([whileOpen, whileLoaded]).toEqual([idle + 1, idle + 1]);
		expect(atDestroyed).toEqual([idle + 1]);
		expect(heldChildren()).toBe(idle);
	});

	it("holds the loop until a session's close has been answered", async () => {
		// A session's tab reports closed before Chrome answers the
		// call that disposed its context, so a hold that ended with
		// the last tab would leave that answer awaited with nothing
		// holding the loop.
		const idle = heldChildren();
		const browser = await getBrowser();
		const tabs: Page[] = [];
		const collect = (target: Target): void => {
			void target.page().then((tab) => tab && tabs.push(tab));
		};
		browser.on("targetcreated", collect);
		const session = await BrowserSession.open("event-loop");
		browser.off("targetcreated", collect);
		await session.navigate(fixture.url("/hello"));
		const atClose: number[] = [];
		for (const tab of tabs) {
			tab.once("close", () => atClose.push(heldChildren()));
		}

		await session.close();

		expect(atClose).toEqual([idle + 1]);
		expect(heldChildren()).toBe(idle);
	});

	it("holds the loop while a crashed tab is replaced", async () => {
		// Recovery closes the dead tab before it opens the new one,
		// so for that moment the session has no tab of its own.
		const idle = heldChildren();
		const browser = await getBrowser();
		const tabs: Page[] = [];
		const collect = (target: Target): void => {
			void target.page().then((tab) => tab && tabs.push(tab));
		};
		browser.on("targetcreated", collect);
		const session = await BrowserSession.open("event-loop-crash");
		browser.off("targetcreated", collect);
		const atClose: number[] = [];
		try {
			await session.navigate(fixture.url("/hello"));
			for (const tab of tabs) {
				tab.once("close", () => atClose.push(heldChildren()));
			}
			await session.navigate("chrome://crash");
			const after = await session.navigate(fixture.url("/hello"));
			expect(after.failure).toBeUndefined();
		} finally {
			await session.close();
		}

		expect(atClose).toEqual([idle + 1]);
		expect(heldChildren()).toBe(idle);
	});
});
