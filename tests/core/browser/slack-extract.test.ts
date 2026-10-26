/**
 * Stopping a Slack credential extraction that nobody is going to finish.
 *
 * The extraction opens a Chrome window and polls it for up to five
 * minutes while a person signs in. A person who gives up has to be able
 * to say so, and saying so has to take the window with it; and a signal
 * to this process has to kill that Chrome without taking the host's exit,
 * the way the warm browser's handlers now do.
 */

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isPidAlive } from "../../../lib/core/web/browser.ts";
import { extractFromBrowser } from "../../../lib/slack/auth/browser-extract.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Short enough that an extraction ignoring its signal fails on its own
 * clock inside the test's, so the failure is an assertion, not a hang.
 */
const EXTRACTION_CLOCK_MS = 15_000;

/** Less than the quickest Chrome launch, which is several times this. */
const NO_LAUNCH_MS = 100;

/** Chrome processes puppeteer launched with a profile of its own. */
function extractionChromes(): number[] {
	const listing = execFileSync("ps", ["-axo", "pid=,command="], {
		encoding: "utf8",
	});
	return listing
		.split("\n")
		.filter((line) => line.includes("puppeteer_dev_chrome_profile"))
		.map((line) => Number.parseInt(line.trim(), 10))
		.filter((pid) => pid > 0);
}

async function gone(pids: number[]): Promise<boolean> {
	const end = Date.now() + 5000;
	while (pids.some(isPidAlive) && Date.now() < end) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !pids.some(isPidAlive);
}

let fixture: Fixture;

describe.skipIf(!haveChrome)("a Slack credential extraction", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/signin", body: page("Sign in", "<main>Sign in</main>") },
		]);
	});

	afterAll(async () => {
		await fixture?.close();
	});

	it("never opens a window when its signal has already fired", async () => {
		const before = extractionChromes();
		const stop = new AbortController();
		stop.abort();
		const started = Date.now();

		await expect(
			extractFromBrowser(
				fixture.url("/signin"),
				EXTRACTION_CLOCK_MS,
				undefined,
				{
					signal: stop.signal,
					headless: true,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
		// A launch alone takes longer than this, even one closed at once.
		expect(Date.now() - started).toBeLessThan(NO_LAUNCH_MS);
		expect(extractionChromes()).toEqual(before);
	});

	it("stops, and closes its window, as soon as its signal fires", async () => {
		const before = new Set(extractionChromes());
		const stop = new AbortController();
		let chromes: number[] = [];
		const extraction = extractFromBrowser(
			fixture.url("/signin"),
			EXTRACTION_CLOCK_MS,
			() => {
				chromes = extractionChromes().filter((pid) => !before.has(pid));
				setTimeout(() => stop.abort(), 200);
			},
			{ signal: stop.signal, headless: true },
		);
		const started = Date.now();

		await expect(extraction).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(chromes.length).toBeGreaterThan(0);
		expect(await gone(chromes)).toBe(true);
	});

	it("kills its Chrome on a signal and leaves the exit to the host", async () => {
		const before = new Set(extractionChromes());
		const counts = SIGNALS.map((signal) => process.listenerCount(signal));
		const host = vi.fn();
		// SIGINT, because puppeteer's own handler for it calls process.exit.
		process.on("SIGINT", host);
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		const stop = new AbortController();
		let chromes: number[] = [];
		let during: number[] = [];
		let signalled = (): void => {};
		const delivered = new Promise<void>((resolve) => {
			signalled = resolve;
		});
		const extraction = extractFromBrowser(
			fixture.url("/signin"),
			EXTRACTION_CLOCK_MS,
			() => {
				chromes = extractionChromes().filter((pid) => !before.has(pid));
				during = SIGNALS.map((signal) => process.listenerCount(signal));
				process.emit("SIGINT", "SIGINT");
				signalled();
			},
			{ signal: stop.signal, headless: true },
		);
		// A killed Chrome ends the extraction one way or another, possibly
		// while the checks below are still waiting; what matters is that the
		// host heard the signal and nothing exited.
		const settled = extraction.catch(() => undefined);
		try {
			await delivered;
			// Gone because of the signal, not because the extraction ended
			// and closed its window, which takes the whole clock.
			expect(chromes.length).toBeGreaterThan(0);
			expect(await gone(chromes)).toBe(true);
			expect(exit).not.toHaveBeenCalled();
			expect(host).toHaveBeenCalledTimes(1);
			await settled;
			for (const [index, count] of during.entries()) {
				expect(count - (counts[index] ?? 0)).toBeLessThanOrEqual(
					SIGNALS[index] === "SIGINT" ? 2 : 1,
				);
			}
		} finally {
			stop.abort();
			exit.mockRestore();
			process.off("SIGINT", host);
		}
		expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(
			counts,
		);
	});
});
