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
import { SETTLE_QUIET_MS } from "../../lib/web/wait/index.js";
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

		// Same reasoning as the settle above: the assertion is that a
		// quiet window is noticed, so the timeout has to be a multiple
		// of that window rather than a round number that happened to
		// pass on an idle machine.
		const quietMs = 200;
		const outcome = await session.waitFor(
			{ kind: "idle", quietMs },
			quietMs * 150,
		);

		expect(outcome.met).toBe(true);
	});

	it("reaches a tab the page opened, and reads it", async () => {
		// A click that opens a tab currently looks like a click that did
		// nothing. This is the whole reason the capability exists, so it
		// is tested through a real window.open rather than by making a
		// second page ourselves.
		await session.navigate(fixture.url("/first"));
		await session.evaluate(
			`window.open(${JSON.stringify(fixture.url("/second"))}, "_blank")`,
		);

		// The browser makes the tab on its own schedule, so this polls
		// rather than sleeping on a number that would be a guess here
		// and a flake on a loaded machine.
		let tabs = await session.tabs();
		for (let tries = 0; tries < 40 && tabs.length < 2; tries += 1) {
			await new Promise((wake) => setTimeout(wake, 50));
			tabs = await session.tabs();
		}

		expect(tabs.length).toBeGreaterThan(1);
		const opened = tabs.find((tab) => tab.url.includes("/second"));
		expect(opened).toBeDefined();
		expect(opened?.current).toBe(false);

		const switched = await session.switchTab(opened?.index ?? 0);
		expect("refusal" in switched).toBe(false);

		// The point is not that the list changed but that reads follow.
		const here = await session.evaluate("document.title");
		expect(here.ok && here.result.value).toBe("Second");
	});

	it("refuses a tab that is not open rather than going quiet", async () => {
		const switched = await session.switchTab(99);

		expect("refusal" in switched).toBe(true);
	});

	it("waits for an attribute to reach a value", async () => {
		// The shape of every async interaction: a control marks itself
		// busy, then clears it. Waiting on a duration instead is the
		// flake this replaces.
		await session.navigate(fixture.url("/first"));
		await session.evaluate(
			"const b = document.createElement('button');" +
				"b.id = 'save'; b.setAttribute('aria-busy', 'true');" +
				"document.body.append(b);" +
				"setTimeout(() => b.setAttribute('aria-busy', 'false'), 300); 'go'",
		);

		const outcome = await session.waitFor(
			{
				kind: "attribute",
				selector: "#save",
				attribute: "aria-busy",
				value: "false",
			},
			5_000,
		);

		expect(outcome.met).toBe(true);
	});

	it("will not call a missing element an absent attribute", async () => {
		// Waiting for an attribute to go away must not be satisfied by
		// a control that never rendered, or the wait passes hardest
		// exactly when the page is broken.
		await session.navigate(fixture.url("/first"));

		const outcome = await session.waitFor(
			{ kind: "attribute", selector: "#nothing", attribute: "aria-busy" },
			300,
		);

		expect(outcome.met).toBe(false);
		expect(outcome.saw).toContain("Nothing matches");
	});

	it("waits for a number of elements to arrive", async () => {
		await session.navigate(fixture.url("/first"));
		await session.evaluate(
			"let n = 0; const add = () => {" +
				"const li = document.createElement('li');" +
				"li.className = 'row'; document.body.append(li);" +
				"if (++n < 4) setTimeout(add, 60); };" +
				"setTimeout(add, 60); 'go'",
		);

		const outcome = await session.waitFor(
			{ kind: "count", selector: "li.row", count: 4 },
			5_000,
		);

		expect(outcome.met).toBe(true);
	});

	it("keeps waiting when a request answers the wrong status", async () => {
		// Without the status, a save that returned 500 ends the wait as
		// happily as one that worked.
		await session.navigate(fixture.url("/first"));
		await session.evaluate(
			`fetch(${JSON.stringify(fixture.url("/missing-thing"))}); 'sent'`,
		);

		const outcome = await session.waitFor(
			{ kind: "request", pattern: "*/missing-thing", status: 200 },
			1_000,
		);

		expect(outcome.met).toBe(false);
		expect(outcome.saw).toContain("404");

		// The control, with a fresh request because a wait only counts
		// what started after it did: without a status, the same 404
		// satisfies it. Otherwise this test would pass on a wait that
		// never succeeds at all.
		const loose = session.waitFor(
			{ kind: "request", pattern: "*/missing-thing" },
			5_000,
		);
		await session.evaluate(
			`fetch(${JSON.stringify(fixture.url("/missing-thing"))}); 'again'`,
		);
		expect((await loose).met).toBe(true);
	});

	it("waits out a plain duration", async () => {
		const outcome = await session.waitFor({ kind: "duration", ms: 250 }, 5_000);

		expect(outcome.met).toBe(true);
		// Measured at 249 once: a timer can come back a whisker early,
		// and the elapsed figure is rounded from a clock of its own.
		// The claim worth holding is that it waited about as long as
		// asked, not that it never rounds down by a millisecond, which
		// is a property of the platform's clock rather than of this.
		expect(outcome.waitedMs).toBeGreaterThanOrEqual(240);
		expect(outcome.waitedMs).toBeLessThan(1_000);
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

		// Sized from the interval under test rather than from what
		// looks safe. The property is that quiet gets detected, and
		// detecting it needs a budget comfortably larger than the quiet
		// window; both stretch together on a loaded machine, and the
		// default is chosen for an interactive read rather than for a
		// test sharing a machine with three other browsers. With the
		// default this failed intermittently, which taught nothing
		// except to distrust the suite.
		const settled = await session.settlePage(SETTLE_QUIET_MS * 40);

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
