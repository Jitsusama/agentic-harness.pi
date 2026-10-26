/**
 * A second, separate connection to the one warm browser.
 *
 * connectShared() exists for a caller that is not the process that
 * launched Chrome: a stateless-per-invocation CLI has no processGlobal
 * state to find getBrowser()'s singleton in, so it needs a different way
 * in — the DevTools WebSocket endpoint the launching process published
 * to disk. This is a real-Chrome test rather than a unit test because
 * the thing being proven is that Chrome actually accepts a second,
 * independent DevTools connection over the port while the launching
 * process is still holding its own connection over the pipe, which is
 * not something a mock can stand in for.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	closeBrowser,
	connectShared,
	getBrowser,
} from "../../../lib/core/web/browser.ts";
import { haveChrome } from "./_harness.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe.skipIf(!haveChrome)("connectShared", () => {
	beforeAll(async () => {
		// Establishes this process as the owner: launches Chrome and
		// publishes the reconnect endpoint connectShared() reads back.
		await getBrowser();
	});

	afterAll(async () => {
		await closeBrowser();
	});

	it("attaches to the browser this same process already launched", async () => {
		const shared = await connectShared();
		expect(shared).toBeDefined();
		try {
			// A real, working connection: it can open a page against the
			// same browser the owning process is holding open.
			const page = await shared?.newPage();
			expect(page).toBeDefined();
			await page?.close();
		} finally {
			// disconnect(), never close(): this connection does not own the
			// browser, and close() would tear it down out from under the
			// process that actually launched it.
			shared?.disconnect();
		}
	});
});
