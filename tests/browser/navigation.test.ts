/**
 * Going somewhere, coming back, and knowing when to stop waiting.
 *
 * These are the methods every other suite is built on, and none
 * of them had a test. The interesting cases are not "did it load"
 * but the ones where the answer is about time or about an edge: a
 * page still fetching when the call returns, a wait that has to
 * give up and say what it saw instead, a step past the end of the
 * history that must refuse rather than quietly stay put.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FIRST = page("First", "<main><h1>First</h1><p>one</p></main>");
const SECOND = page("Second", "<main><h1>Second</h1><p>two</p></main>");

/** A page that only finishes once its slow subresource does. */
const SLOW = page(
	"Slow",
	'<main><h1>Slow</h1></main><img alt="" src="/slow.png">',
);

/** A page that adds a node on a timer, for waiting on. */
const LATER = page(
	"Later",
	`<main><h1>Later</h1><div id="host"></div></main>
<script>
setTimeout(() => {
  const el = document.createElement("p");
  el.id = "arrived";
  el.textContent = "arrived at last";
  document.getElementById("host").append(el);
}, 400);
</script>`,
);

/** A page that never stops changing, so it can never settle. */
const RESTLESS = page(
	"Restless",
	`<main><h1>Restless</h1><div id="host"></div></main>
<script>
setInterval(() => {
  const el = document.createElement("span");
  el.textContent = String(Date.now());
  document.getElementById("host").append(el);
}, 30);
</script>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("navigating, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/first", body: FIRST },
			{ path: "/second", body: SECOND },
			{ path: "/slow", body: SLOW },
			{ path: "/slow.png", body: "", status: 404, delayMs: 400 },
			{ path: "/later", body: LATER },
			{ path: "/restless", body: RESTLESS },
		]);
		session = await BrowserSession.open("navigation-contract");
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("reports the url it actually landed on", async () => {
		await session.navigate(fixture.url("/first"));

		expect(session.url).toBe(fixture.url("/first"));
	});

	it("reports the status the server gave it", async () => {
		const outcome = await session.navigate(fixture.url("/first"));

		expect(outcome.status).toBe(200);
		expect(outcome.failure).toBeUndefined();
	});

	it("reports a failure to reach a host rather than throwing", async () => {
		// A caller who mistyped a host wants to be told, in the same
		// shape as every other answer. Throwing here would end the
		// session over a typo.
		const outcome = await session.navigate("http://127.0.0.1:1/nothing");

		expect(outcome.failure).toBeDefined();
	});

	it("walks back and forward through its own history", async () => {
		await session.navigate(fixture.url("/first"));
		await session.navigate(fixture.url("/second"));

		const back = await session.step("back");
		expect(back.ok).toBe(true);
		expect(session.url).toBe(fixture.url("/first"));

		const forward = await session.step("forward");
		expect(forward.ok).toBe(true);
		expect(session.url).toBe(fixture.url("/second"));
	});

	it("refuses a step past the end rather than quietly staying put", async () => {
		// Staying put silently looks identical to a page that ignored
		// the request, and the caller then cannot tell whether going
		// forward was possible at all.
		await session.navigate(fixture.url("/first"));
		await session.navigate(fixture.url("/second"));

		const outcome = await session.step("forward");

		expect(outcome.ok).toBe(false);
	});

	it("reloads without losing where it is", async () => {
		await session.navigate(fixture.url("/second"));

		await session.reload();

		expect(session.url).toBe(fixture.url("/second"));
	});

	it("waits for an element that is not there yet", async () => {
		await session.navigate(fixture.url("/later"));

		const outcome = await session.waitFor(
			{ kind: "selector", selector: "#arrived" },
			5_000,
		);

		expect(outcome.met).toBe(true);
	});

	it("gives up on an element that never arrives, and reports the wait", async () => {
		// The failure is reported rather than thrown, because "it
		// never showed up" is frequently the finding itself.
		await session.navigate(fixture.url("/first"));

		const outcome = await session.waitFor(
			{ kind: "selector", selector: "#never-in-a-hundred-years" },
			500,
		);

		expect(outcome.met).toBe(false);
		expect(outcome.waitedMs).toBeGreaterThanOrEqual(500);
	});

	it("waits for text the page has not written yet", async () => {
		await session.navigate(fixture.url("/later"));

		const outcome = await session.waitFor(
			{ kind: "text", text: "arrived at last" },
			5_000,
		);

		expect(outcome.met).toBe(true);
	});

	it("waits for an element to leave", async () => {
		await session.navigate(fixture.url("/later"));
		await session.waitFor({ kind: "selector", selector: "#arrived" }, 5_000);
		await session.evaluate("document.getElementById('arrived').remove()");

		const outcome = await session.waitFor(
			{ kind: "gone", selector: "#arrived" },
			5_000,
		);

		expect(outcome.met).toBe(true);
	});

	it("waits for the network to go quiet", async () => {
		await session.navigate(fixture.url("/slow"));

		const outcome = await session.waitFor(
			{ kind: "idle", quietMs: 200 },
			10_000,
		);

		expect(outcome.met).toBe(true);
	});

	it("waits out a plain duration", async () => {
		const outcome = await session.waitFor({ kind: "duration", ms: 250 }, 5_000);

		expect(outcome.met).toBe(true);
		expect(outcome.waitedMs).toBeGreaterThanOrEqual(250);
	});

	it("records the page it went to, not merely that something happened", async () => {
		// A count greater than zero would pass against a log full of
		// anything at all. The url is the part a caller reconstructs a
		// navigation from.
		await session.navigate(fixture.url("/second"));
		await session.navigate(fixture.url("/first"));

		const urls = session.history.map((event) => event.url);

		expect(urls).toContain(fixture.url("/first"));
	});

	it("settles a quiet page and says it was quiet", async () => {
		await session.navigate(fixture.url("/first"));

		const settled = await session.settlePage();

		expect(settled.quiet).toBe(true);
		expect(session.settledLast?.quiet).toBe(true);
	});

	it("counts the mutations of a page that will not sit still", async () => {
		// A page mutating on a timer never goes quiet, and the count is
		// how a caller learns that rather than guessing from a timeout.
		await session.navigate(fixture.url("/restless"));

		const settled = await session.settlePage();

		expect(settled.quiet).toBe(false);
		expect(settled.mutations).toBeGreaterThan(0);
	});
});
