/**
 * The hydration capture, checked against a real browser.
 *
 * The unit tests judge captures; these check that the capture
 * fetches the real server render, parses it without running its
 * scripts, and reads the live document after those scripts ran.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { judgeHydration } from "../../../lib/core/web/hydration/judge.ts";
import { BrowserSession } from "../../../lib/core/web/session.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A page whose script rewrites what the server sent. */
const MUTATES = page(
	"Mutates",
	`<main>
  <h1>Mutates</h1>
  <p id="kept">This paragraph survives hydration untouched, present in both renders.</p>
  <p id="lost">This paragraph is removed by the page's own script after it loads.</p>
</main>
<script>
  document.getElementById("lost").remove();
  const extra = document.createElement("p");
  extra.textContent = "This paragraph only exists after the script has run.";
  document.querySelector("main").appendChild(extra);
</script>`,
);

/** A page whose script leaves the server render alone. */
const FAITHFUL = page(
	"Faithful",
	`<main>
  <h1>Faithful</h1>
  <p>This paragraph is rendered by the server and left alone by every script.</p>
</main>
<script>void 0;</script>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("hydration capture, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/mutates", body: MUTATES },
			{ path: "/faithful", body: FAITHFUL },
		]);
		session = await BrowserSession.open("hydration-contract");
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("passes a page whose scripts leave the server render alone", async () => {
		await session.navigate(fixture.url("/faithful"));
		const capture = await session.hydration();

		expect(capture.fetched).toBe(true);
		expect(judgeHydration(capture).standing).toBe("pass");
	});

	it("sees the server render before scripts, the live one after", async () => {
		await session.navigate(fixture.url("/mutates"));
		const capture = await session.hydration();
		const report = judgeHydration(capture);

		// The removed paragraph exists only in the unexecuted server
		// parse; the added one only in the live document. If the
		// server HTML had been parsed with scripts running, both
		// lists would be empty and this test is the tripwire.
		expect(report.vanished.join(" ")).toContain("removed by the page");
		expect(report.appeared.join(" ")).toContain("after the script has run");
		expect(report.standing).toBe("fail");
	});
});
