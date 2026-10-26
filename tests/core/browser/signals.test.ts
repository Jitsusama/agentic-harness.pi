/**
 * What the warm browser does when this process is signalled.
 *
 * Chrome must not outlive the process, so a signal kills it. But the
 * process belongs to its host: pi saves its session and restores the
 * terminal on SIGTERM and SIGHUP, and a library that answers the same
 * signal with `process.exit` ends the process before the host's handler
 * has run. Puppeteer's own handlers did exactly that, and so did ours.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import {
	closeBrowser,
	getBrowser,
	isPidAlive,
} from "../../../lib/core/web/browser.ts";
import { haveChrome } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function listeners(): Record<string, number> {
	return Object.fromEntries(
		SIGNALS.map((signal) => [signal, process.listenerCount(signal)]),
	);
}

describe.skipIf(!haveChrome)(
	"the warm browser and this process's signals",
	() => {
		afterAll(async () => {
			await closeBrowser();
		});

		it("adds at most its own one handler to each signal", async () => {
			const before = listeners();
			await getBrowser();
			const after = listeners();

			for (const signal of SIGNALS) {
				expect(after[signal] - before[signal]).toBeLessThanOrEqual(1);
			}
		});

		it("kills Chrome on a signal and leaves the exit to the host's handler", async () => {
			const browser = await getBrowser();
			const pid = browser.process()?.pid;
			expect(pid).toBeGreaterThan(0);
			const host = vi.fn();
			process.on("SIGHUP", host);
			try {
				// Delivered to the listeners the way a real signal is, without
				// the real one, which would end this worker if nothing listened.
				process.emit("SIGHUP", "SIGHUP");

				expect(host).toHaveBeenCalledTimes(1);
				const end = Date.now() + 5000;
				while (isPidAlive(pid ?? 0) && Date.now() < end) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				expect(isPidAlive(pid ?? 0)).toBe(false);
			} finally {
				process.off("SIGHUP", host);
			}
		});
	},
);
