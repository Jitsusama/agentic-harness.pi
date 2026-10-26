/**
 * Whether reading a page always lets go: on its own, when the page
 * cannot run script, and at once when its caller gives up.
 *
 * A response carrying the CSP sandbox directive runs no script, and
 * to Chrome a timer's callback is script. Every wait that had the
 * page count out its own setTimeout then never finished, and the one
 * CDP call behind it sat for puppeteer's three-minute protocol
 * timeout. That is the web_read of a raw GitHub file that took 180
 * seconds and failed, and a browser session navigating to one does
 * the same.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeBrowser, getBrowser } from "../../../lib/core/web/browser.ts";
import { readPage } from "../../../lib/core/web/reader.ts";
import { webSearch } from "../../../lib/core/web/search.ts";
import { BrowserSession } from "../../../lib/core/web/session.ts";
import { SETTLE_BUDGET_MS } from "../../../lib/core/web/wait/index.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SANDBOXED = page(
	"Sandboxed",
	"<main><h1>Sandboxed</h1><p>still</p></main>",
);
const PLAIN = page("Plain", "<main><h1>Plain</h1><p>fine</p></main>");

/** Longer than any test here waits, so a load held this long never lands. */
const NEVER_MS = 120_000;

/** How far past its own budget a settle may run before it counts as stuck. */
const SETTLE_SLACK_MS = 2_000;

/**
 * Race a promise against a deadline, so a hang fails as an
 * assertion naming the wait rather than as the suite's timeout.
 */
async function within<T>(
	ms: number,
	what: string,
	work: Promise<T>,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} was still waiting after ${ms} ms`)),
			ms,
		);
	});
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
	}
}

let fixture: Fixture;

describe.skipIf(!haveChrome)("reading a page always lets go", () => {
	beforeAll(async () => {
		fixture = await serve([
			{
				path: "/sandboxed",
				body: SANDBOXED,
				headers: { "content-security-policy": "sandbox" },
			},
			{
				path: "/raw.md",
				body: "# Architecture\n\nPlain text, served the way a raw file is.\n",
				type: "text/plain; charset=utf-8",
				headers: {
					"content-security-policy":
						"default-src 'none'; style-src 'unsafe-inline'; sandbox",
				},
			},
			{ path: "/plain", body: PLAIN },
			{ path: "/never", body: PLAIN, delayMs: NEVER_MS },
		]);
	});

	afterAll(async () => {
		await closeBrowser();
		await fixture?.close();
	});

	it("reads a raw file whose sandbox stops its timers", async () => {
		const bundle = await within(
			15_000,
			"reading a sandboxed raw file",
			readPage(fixture.url("/raw.md")),
		);

		expect(bundle.screenshotPaths.length).toBeGreaterThan(0);
	});

	it("reads a sandboxed HTML page too, since the type is not the cause", async () => {
		const bundle = await within(
			15_000,
			"reading a sandboxed page",
			readPage(fixture.url("/sandboxed")),
		);

		expect(bundle.title).toBe("Sandboxed");
	});

	it("lets a session settle a sandboxed page within its budget", async () => {
		const session = await BrowserSession.open("bounded-sandbox");
		try {
			const started = Date.now();
			const landed = await within(
				SETTLE_BUDGET_MS + SETTLE_SLACK_MS + 5_000,
				"navigating to a sandboxed page",
				session.navigate(fixture.url("/sandboxed")),
			);

			expect(landed.failure).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(
				SETTLE_BUDGET_MS + SETTLE_SLACK_MS,
			);
			// Nothing in a page that runs no script can change it, so
			// calling it still changing would be untrue.
			expect(session.settledLast?.quiet).toBe(true);
		} finally {
			await session.close();
		}
	});

	it("gives up on a read at once when its caller aborts, and says it aborted", async () => {
		const browser = await getBrowser();
		const before = new Set(browser.browserContexts());
		const controller = new AbortController();
		const reading = readPage(fixture.url("/never"), controller.signal);
		setTimeout(() => controller.abort(), 300);
		const started = Date.now();

		const outcome = await within(
			5_000,
			"an aborted read",
			reading.then(
				() => "resolved",
				(err: unknown) => err,
			),
		);

		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).name).toBe("AbortError");
		expect(Date.now() - started).toBeLessThan(2_000);
		// The tab is closed behind the caller's back, not left open.
		await vi.waitFor(
			() => {
				const left = browser.browserContexts().filter((c) => !before.has(c));
				expect(left).toHaveLength(0);
			},
			{ timeout: 5_000, interval: 50 },
		);
	});

	it("says a search aborted before it began aborted, not that it found nothing", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(webSearch("anything", 3, controller.signal)).rejects.toThrow(
			expect.objectContaining({ name: "AbortError" }),
		);
	});

	it("leaves no tab or context of its own behind", async () => {
		const browser = await getBrowser();
		const contexts = new Set(browser.browserContexts());
		const pages = new Set(await browser.pages());

		await readPage(fixture.url("/plain"));

		const newContexts = browser
			.browserContexts()
			.filter((c) => !contexts.has(c));
		const newPages = (await browser.pages()).filter((p) => !pages.has(p));
		expect(newContexts).toHaveLength(0);
		expect(newPages).toHaveLength(0);
	});
});
