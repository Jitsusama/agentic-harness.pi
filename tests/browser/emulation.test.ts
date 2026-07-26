/**
 * The emulation contract, checked against a real browser.
 *
 * These are the only tests in this repo that launch Chrome, and
 * they exist because the faults they cover are invisible to every
 * other kind. Each one below shipped, silently: a device name the
 * library accepted and ignored, an override that could never be
 * taken off again, touch that did not survive the first navigation
 * about half the time, a network profile named rather than spelled
 * out that shaped nothing at all. Every one of them reported
 * success. No unit test could have failed, because none of them
 * were wrong about what they computed; they were wrong about what
 * the browser did with it.
 *
 * Served from a server started here rather than from a fixture
 * directory or the internet, so the suite depends on nothing it
 * does not create. The viewport meta tag matters: without one, a
 * page is laid out at the desktop default whatever device is being
 * emulated, which is a real behaviour that has misled me twice.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveChromePath } from "../../lib/web/browser.js";
import { BrowserSession } from "../../lib/web/session.js";

// Launching a browser, loading pages and shaping the network is
// slower than anything else here, and slower still on a loaded
// machine. Each test's own work is a page load.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A page that lays out at the emulated width, and says who asked. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Under test</title>
</head>
<body><main><h1>Under test</h1></main><img alt="" src="/slow.png"></body>
</html>`;

/** What the library gives a touch device, from its own constant. */
const TOUCH_POINTS_EMULATED = 5;

/** Long enough to widen the race, short enough to run often. */
const SLOW_MS = 300;

let server: Server;
let origin: string;
let session: BrowserSession;
let redirector: Server;
let redirectOrigin: string;

/**
 * How many times to repeat the navigation that used to lose touch.
 *
 * The loss is a race, not a rule. Against a real site it went four
 * times in five; through a local server it needed a cross-origin
 * redirect and a slow response to happen at all, and then only
 * about one attempt in three. One attempt would therefore pass most
 * of the time with the fix reverted, which is worse than having no
 * test: it would report a guard that is not there. Repeating pushes
 * the chance of missing a regression under a few percent, and costs
 * a couple of seconds.
 */
const RACE_ATTEMPTS = 5;

/**
 * Whether there is a browser to drive.
 *
 * Skipped rather than failed where there is none, so a checkout on
 * a machine without Chrome still runs the rest of the suite. CI
 * installs one, so a skip there would be a real signal.
 */
const haveChrome = ((): boolean => {
	try {
		resolveChromePath(process.env.CHROME_PATH);
		return true;
	} catch {
		// The only failure mode is "no Chrome", which is the answer.
		return false;
	}
})();

describe.skipIf(!haveChrome)("emulating a device, in a real browser", () => {
	beforeAll(async () => {
		// Serves the page, and a subresource that takes its time, which
		// keeps the navigation in flight long enough for the race below.
		server = createServer((request, response) => {
			if (request.url?.startsWith("/slow")) {
				setTimeout(() => {
					response.writeHead(404);
					response.end();
				}, SLOW_MS);
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end(PAGE);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

		// A second origin that only redirects to the first. Going
		// through it makes the navigation commit in another process,
		// which is the condition the touch override was lost under.
		redirector = createServer((_request, response) => {
			response.writeHead(302, { location: origin });
			response.end();
		});
		await new Promise<void>((resolve) =>
			redirector.listen(0, "localhost", resolve),
		);
		redirectOrigin = `http://localhost:${
			(redirector.address() as AddressInfo).port
		}/`;

		session = await BrowserSession.open("emulation-contract");
	});

	afterAll(async () => {
		await session?.close();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		await new Promise<void>((resolve) => redirector?.close(() => resolve()));
	});

	/** What the page itself believes about its environment. */
	const asThePageSees = async (): Promise<{
		width: number;
		touchPoints: number;
		phoneAgent: boolean;
		timezone: string;
	}> => {
		const outcome = await session.evaluate(
			"({ width: innerWidth, touchPoints: navigator.maxTouchPoints, " +
				"phoneAgent: /iPhone|Android/.test(navigator.userAgent), " +
				"timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })",
		);
		// A page that would not answer must not be read as a page that
		// answered zero, which is what every assertion below looks for.
		if (!outcome.ok) {
			throw new Error(`the page would not answer: ${JSON.stringify(outcome)}`);
		}
		const value = outcome.result.value;
		if (!value || typeof value !== "object") {
			throw new Error(`the page answered nothing useful: ${String(value)}`);
		}
		return value as {
			width: number;
			touchPoints: number;
			phoneAgent: boolean;
			timezone: string;
		};
	};

	it("gives the page the device's screen, touch and name", async () => {
		// The library used to accept the name and apply none of it,
		// reporting no divergence while the viewport stayed at 800x600.
		await session.emulate({ device: "iPhone 15 Pro" });
		await session.navigate(origin);

		const seen = await asThePageSees();
		expect(seen.width).toBe(393);
		expect(seen.touchPoints).toBeGreaterThan(0);
		expect(seen.phoneAgent).toBe(true);
	});

	it("stays a phone across a navigation that changes process", async () => {
		// Touch did not survive the first navigation after being set,
		// so emulate-then-navigate, the order the guide recommends, was
		// a coin flip while the report said "pretending" either way.
		//
		// The cause was ours. A cross-process navigation swaps the
		// target's protocol session, and the driver listens for that
		// swap to put its emulation state on the new one; emulation sent
		// on a session of our own went to the renderer being replaced.
		// Device metrics are held browser-side and came through
		// regardless, which is why it looked like a touch-only fault.
		//
		// This asserted only the weaker "never claims what the page
		// denies" while the fault was two workarounds deep and beaten
		// one time in three. Both workarounds are gone and the strong
		// version holds: the invariant is checked too, since the report
		// must stay honest even if a browser ever loses it again.
		//
		// Note for whoever changes this next: because the fault was a
		// race, this catches its return about half the times it runs,
		// measured by putting the old protocol route back. One green run
		// is not proof. It has never failed with the fix in place.
		//
		// So the assertion is the thing that is true: whatever the
		// browser does, the tool does not claim more than the page will
		// confirm. A tester reading "pretending: iPhone 15 Pro" while
		// the page cannot detect touch is how someone concludes a site
		// is broken on mobile when the tool is what is broken.
		const disagreements: unknown[] = [];
		for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt++) {
			const fresh = await BrowserSession.open(`emulation-claim-${attempt}`);
			try {
				await fresh.emulate({ device: "iPhone 15 Pro" });
				await fresh.navigate(redirectOrigin);
				// What the page says, in full, because a failure here has to
				// arrive with its evidence. This flaked once inside the whole
				// suite and could not be reproduced in seven later runs,
				// three of them the full suite and four under eight CPU
				// hogs, so the next occurrence is the only chance to learn
				// anything and it must not be a bare boolean.
				const answer = await fresh.evaluate(
					"({ touchPoints: navigator.maxTouchPoints, " +
						"width: window.innerWidth, ua: navigator.userAgent })",
				);
				const seen = answer.ok ? answer.result.value : undefined;
				const { emulation, gaps } = await fresh.status();
				// The page is a phone, and the report agrees with it.
				const claimsTouch = emulation.device !== undefined;
				const admits = (gaps ?? []).some((gap) => gap.what === "touch");
				if (!answer.ok) {
					// A probe that did not run is not a page that passed. It
					// used to be read as touch being present, which would let a
					// real loss through on any run where the evaluate failed.
					disagreements.push({ attempt, probeFailed: answer, gaps });
				} else if (
					!(
						typeof seen === "object" &&
						seen !== null &&
						(seen as { touchPoints?: number }).touchPoints !== undefined &&
						((seen as { touchPoints: number }).touchPoints ?? 0) > 0
					)
				) {
					disagreements.push({ attempt, lost: true, seen, emulation, gaps });
				} else if (claimsTouch && admits) {
					disagreements.push({
						attempt,
						claimedAndDenied: true,
						seen,
						gaps,
					});
				}
			} finally {
				await fresh.close();
			}
		}
		expect(disagreements).toEqual([]);
	});

	it("usually keeps emulating across a navigation, and says so when not", async () => {
		// The weaker companion to the invariant above: on the ordinary
		// path, with no redirect to change process, the override does
		// survive and there is nothing to report.
		await session.emulate({ device: "iPhone 15 Pro" });
		await session.navigate(origin);
		await session.navigate(`${origin}?again`);

		expect((await asThePageSees()).touchPoints).toBe(TOUCH_POINTS_EMULATED);
		expect((await session.status()).gaps).toBeUndefined();
	});

	it("keeps emulating after a reload", async () => {
		await session.emulate({ device: "iPhone 15 Pro" });
		await session.navigate(origin);
		await session.reload();

		const seen = await asThePageSees();
		expect(seen.width).toBe(393);
		expect(seen.touchPoints).toBeGreaterThan(0);
	});

	it("reports no gap when the device really did apply", async () => {
		// The gap list is what a caller trusts to tell them the
		// request did not land, so a clean application has to be
		// silent. On a real page, this one is.
		await session.emulate({ device: "iPhone 15 Pro" });
		await session.navigate(origin);

		expect((await session.emulate({})).gaps).toEqual([]);
	});

	it("says a blank page cannot answer yet, rather than inventing a gap", async () => {
		// Emulating before navigating is the order asked for, and it
		// used to answer with two alarming divergences that both come
		// right the moment a page loads. I trusted them and measured
		// the wrong viewport for twenty minutes.
		const fresh = await BrowserSession.open("emulation-blank");
		try {
			const { gaps } = await fresh.emulate({ device: "iPhone 15 Pro" });
			expect(gaps).toHaveLength(1);
			expect(gaps[0]?.observed).toContain("about:blank");
		} finally {
			await fresh.close();
		}
	});

	it("stops pretending when told to", async () => {
		// Nothing could ever be cleared: an absent key and a cleared
		// key arrived identically, so a session that emulated Tokyo
		// once stayed in Tokyo for life.
		await session.emulate({ device: "iPhone 15 Pro", timezone: "Asia/Tokyo" });
		await session.navigate(origin);
		expect((await asThePageSees()).timezone).toBe("Asia/Tokyo");

		await session.emulate({}, ["device", "viewport", "touch", "userAgent"]);
		await session.emulate({}, ["timezone"]);
		await session.navigate(origin);

		const seen = await asThePageSees();
		expect(seen.touchPoints).toBe(0);
		expect(seen.phoneAgent).toBe(false);
		expect(seen.timezone).not.toBe("Asia/Tokyo");
	});

	it("refuses a device it has never heard of, by name", async () => {
		const { gaps } = await session.emulate({ device: "Nokia 3310" });
		expect(gaps.map((gap) => gap.what)).toContain("device");
		expect(gaps.find((gap) => gap.what === "device")?.note).toContain(
			"No device named",
		);
	});
});

describe.skipIf(!haveChrome)("shaping the network, in a real browser", () => {
	let shaped: BrowserSession;
	let shapedServer: Server;
	let shapedOrigin: string;

	beforeAll(async () => {
		shapedServer = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(PAGE);
		});
		await new Promise<void>((resolve) =>
			shapedServer.listen(0, "127.0.0.1", resolve),
		);
		shapedOrigin = `http://127.0.0.1:${
			(shapedServer.address() as AddressInfo).port
		}/`;
		shaped = await BrowserSession.open("shaping-contract");
	});

	afterAll(async () => {
		await shaped?.close();
		await new Promise<void>((resolve) => shapedServer?.close(() => resolve()));
	});

	it("goes offline when offline is asked for by name", async () => {
		// Named rather than spelled out, this shaped nothing: the
		// fields were read off a string, none were found, and a
		// navigation came back 200 while the caller believed the
		// network was down. The test appeared to have run.
		await shaped.navigate(shapedOrigin);
		await shaped.shape({ throttle: "offline" });

		const outcome = await shaped.navigate(shapedOrigin);
		expect(outcome.failure).toBeDefined();
		expect(outcome.status).toBeUndefined();
	});

	it("reports the failure instead of throwing it", async () => {
		// The doc promised a returned status rather than a throw, and
		// then threw the driver's own error, wrapper and stack and all,
		// at a caller who had asked a question.
		await shaped.shape({ throttle: "offline" });
		const outcome = await shaped.navigate(shapedOrigin);
		expect(outcome.failure).toMatch(/net::ERR/);
	});

	it("records the attempt that failed, so it can be read back", async () => {
		await shaped.shape({ throttle: "offline" });
		await shaped.navigate(shapedOrigin);

		const failures = shaped.requests().filter((r) => r.state === "failed");
		expect(failures.length).toBeGreaterThan(0);
		expect(failures.at(-1)?.failure).toMatch(/net::ERR/);
	});

	it("lets the network back on again", async () => {
		await shaped.shape({ throttle: "offline" });
		await shaped.shape({ clear: true });

		const outcome = await shaped.navigate(shapedOrigin);
		expect(outcome.failure).toBeUndefined();
		expect(outcome.status).toBe(200);
	});
});
