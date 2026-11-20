/**
 * The warm browser answers DevTools over its pipe alone.
 *
 * A DevTools port answers any process on the machine with no key, an
 * agent's fenced command among them, and drives the whole unfenced
 * browser: files by file://, downloads written anywhere, the device's
 * certificate. A real Chrome is the proof, since what matters is what
 * it was started with and what it published, not what the code asked.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownProfileDir } from "../../../lib/core/web/browser/profile.ts";
import { closeBrowser, getBrowser } from "../../../lib/core/web/browser.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("the warm browser's DevTools", () => {
	let spawnargs: readonly string[] = [];

	beforeAll(async () => {
		const browser = await getBrowser();
		spawnargs = browser.process()?.spawnargs ?? [];
	});

	afterAll(async () => {
		await closeBrowser();
	});

	it("is started with the pipe and no port", () => {
		expect(spawnargs).toContain("--remote-debugging-pipe");
		expect(
			spawnargs.filter((arg) => arg.startsWith("--remote-debugging-port")),
		).toEqual([]);
	});

	it("publishes no port in its profile", async () => {
		const browser = await getBrowser();
		// A page open proves Chrome is past its start, where it would have
		// written a port it bound.
		const tab = await browser.newPage();
		await tab.close();

		expect(
			fs.existsSync(path.join(ownProfileDir(), "DevToolsActivePort")),
			"Chrome should write no DevToolsActivePort, since it binds no port",
		).toBe(false);
	});
});
