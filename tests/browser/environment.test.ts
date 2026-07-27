/**
 * What the page is allowed to keep, and the conditions it runs
 * under.
 *
 * Storage and network shaping are the two ways a session pretends
 * to be a different visit, and neither had a test. The cases that
 * matter are the ones where a change must actually reach the page
 * rather than merely being recorded: a value the page can read
 * back, a clear the page can see, a throttle that makes a request
 * take longer, and an emulation state that can be put back the way
 * it was found.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const STORE = page(
	"Storage",
	`<main><h1>Storage</h1></main>
<script>
localStorage.setItem("from-the-page", "local value");
sessionStorage.setItem("session-key", "session value");
document.cookie = "baked=yes; path=/";
</script>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)(
	"the visit's conditions, in a real browser",
	() => {
		beforeAll(async () => {
			fixture = await serve([
				{ path: "/store", body: STORE },
				{ path: "/plain", body: page("Plain", "<main><h1>Plain</h1></main>") },
				{ path: "/data.json", body: '{"n":1}', type: "application/json" },
			]);
			session = await BrowserSession.open("environment-contract");
			await session.navigate(fixture.url("/store"));
		});

		afterAll(async () => {
			await session?.close();
			await fixture?.close();
		});

		it("reads what the page put in local storage", async () => {
			const kept = await session.storage({ local: true });

			expect(JSON.stringify(kept)).toContain("local value");
		});

		it("reads session storage separately from local", async () => {
			const kept = await session.storage({ session: true });

			expect(JSON.stringify(kept)).toContain("session value");
		});

		it("reads the cookies the page set", async () => {
			const kept = await session.storage({ cookies: true });

			expect(JSON.stringify(kept)).toContain("baked");
		});

		it("writes a value the page can then read back", async () => {
			// Writing into a store the page cannot see would be a
			// convincing illusion and no use to anybody.
			await session.setStored(true, "written-by-us", "our value");

			const readBack = await session.evaluate(
				"localStorage.getItem('written-by-us')",
			);
			expect(readBack.ok && readBack.result.value).toBe("our value");
		});

		it("clears a store, and the page sees it gone", async () => {
			await session.setStored(true, "to-be-cleared", "temporary");

			await session.clearStorage({ local: true });

			const readBack = await session.evaluate(
				"localStorage.getItem('to-be-cleared')",
			);
			expect(readBack.ok && readBack.result.value).toBe(null);
		});

		it("clears only the store it was asked to clear", async () => {
			await session.navigate(fixture.url("/store"));

			await session.clearStorage({ local: true });

			const survivor = await session.evaluate(
				"sessionStorage.getItem('session-key')",
			);
			expect(survivor.ok && survivor.result.value).toBe("session value");
		});

		it("reports the shaping in force, having been given a profile by name", async () => {
			await session.shape({ throttle: "slow-3g" });
			try {
				expect(session.shaping.throttle).toBeDefined();
			} finally {
				await session.shape({ throttle: "none" });
			}
		});

		it("actually slows a request down when throttled", async () => {
			// A profile that is recorded and never applied is the exact
			// fault the emulation suite was written for, on a different
			// knob. Timing is the only way to tell the two apart.
			await session.navigate(fixture.url("/plain"));
			const timed = async (): Promise<number> => {
				const started = Date.now();
				await session.evaluate(
					"fetch('/data.json?x=' + Math.random()).then(r => r.text())",
				);
				await session.waitFor({ kind: "idle", quietMs: 200 }, 30_000);
				return Date.now() - started;
			};

			const quick = await timed();
			await session.shape({ throttle: "slow-3g" });
			try {
				const slow = await timed();
				expect(slow).toBeGreaterThan(quick);
			} finally {
				await session.shape({ throttle: "none" });
			}
		});

		it("refuses to reach the network at all when offline", async () => {
			await session.navigate(fixture.url("/plain"));
			await session.shape({ throttle: "offline" });
			try {
				const answer = await session.evaluate(
					"fetch('/data.json').then(() => 'reached').catch(() => 'refused')",
				);

				expect(answer.ok && answer.result.value).toBe("refused");
			} finally {
				await session.shape({ throttle: "none" });
			}
		});

		it("blocks a url pattern the caller named", async () => {
			await session.navigate(fixture.url("/plain"));
			await session.shape({
				rules: [{ action: "block", pattern: "*/data.json" }],
			});
			try {
				const answer = await session.evaluate(
					"fetch('/data.json').then(() => 'reached').catch(() => 'blocked')",
				);

				expect(answer.ok && answer.result.value).toBe("blocked");
			} finally {
				await session.shape({ rules: [] });
			}
		});

		it("answers a mocked url itself, without troubling the server", async () => {
			await session.navigate(fixture.url("/plain"));
			await session.shape({
				rules: [
					{
						action: "mock",
						pattern: "*/invented.json",
						status: 200,
						body: '{"invented":true}',
						contentType: "application/json",
					},
				],
			});
			try {
				const answer = await session.evaluate(
					"fetch('/invented.json').then(r => r.text())",
				);

				expect(String(answer.ok && answer.result.value)).toContain("invented");
			} finally {
				await session.shape({ rules: [] });
			}
		});

		it("puts an emulation state back the way it was found", async () => {
			// Restoring is not the same as clearing an override: clearing
			// hands the page to puppeteer's own default, which is not where
			// it started.
			const before = session.emulated;

			await session.emulate({ viewport: { width: 375, height: 700 } });
			await session.restoreEmulation(before);

			expect(session.emulated).toEqual(before);
		});

		it("says whether it is pretending to have a touch screen", async () => {
			const before = session.emulated;
			try {
				await session.emulate({ touch: true });

				expect(session.touchEmulated).toBe(true);
			} finally {
				await session.restoreEmulation(before);
			}
		});

		it("remembers when it was last used, so an idle session can be reaped", async () => {
			const before = session.lastUsedAt;
			await session.waitFor({ kind: "duration", ms: 20 }, 1_000);

			await session.evaluate("1 + 1");

			expect(session.lastUsedAt).toBeGreaterThan(before);
		});
	},
);
