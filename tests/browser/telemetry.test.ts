/**
 * What the page said, asked for, offered and announced.
 *
 * These feed the answers the store bounds and cites, so a fault
 * here is one a caller cannot see past: the citation would be
 * honest about a payload that was wrong. None of them had a test.
 *
 * The cases worth writing are about capture rather than
 * formatting. A console error that arrives before anyone asks. A
 * failed request that has no response to report. A dialog that
 * stops the page until it is answered, where the policy decides
 * whether the page ever continues. A live region that announces
 * after the fact.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NOISY = page(
	"Noisy",
	`<main><h1>Noisy</h1></main>
<script>
console.log("a plain log");
console.warn("a warning");
console.error("an error happened");
fetch("/data.json").catch(() => {});
fetch("/missing").catch(() => {});
fetch("http://127.0.0.1:1/unreachable").catch(() => {});
</script>`,
);

const DIALOGS = page(
	"Dialogs",
	`<main><h1>Dialogs</h1><p id="answer">unasked</p>
<script>
window.ask = () => {
  document.getElementById("answer").textContent = String(confirm("Really?"));
};
window.askText = () => {
  document.getElementById("answer").textContent = String(prompt("Name?", ""));
};
</script></main>`,
);

const LIVE = page(
	"Live",
	`<main><h1>Live</h1>
<div id="status" role="status" aria-live="polite"></div>
<div id="alert" role="alert"></div>
</main>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("telemetry, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/noisy", body: NOISY },
			{ path: "/data.json", body: '{"ok":true}', type: "application/json" },
			{ path: "/dialogs", body: DIALOGS },
			{ path: "/live", body: LIVE },
		]);
		session = await BrowserSession.open("telemetry-contract");
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("keeps what the page said before anyone asked", async () => {
		// The console is written at load, long before a caller thinks
		// to look. Capture that starts when asked captures nothing.
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);

		const { entries } = session.logs();
		const messages = entries.map((entry) => entry.item.text);

		expect(messages.some((text) => text.includes("a plain log"))).toBe(true);
		expect(messages.some((text) => text.includes("an error happened"))).toBe(
			true,
		);
	});

	it("keeps the level, so errors can be told from chatter", async () => {
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);

		const levels = new Set(session.logs().entries.map((e) => e.item.level));

		expect(levels.has("error")).toBe(true);
	});

	it("reads only what arrived after a cursor", async () => {
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);
		const first = session.logs();

		await session.evaluate("console.log('after the cursor')");
		const later = session.logs(first.cursor);

		const texts = later.entries.map((entry) => entry.item.text);
		expect(texts.some((text) => text.includes("after the cursor"))).toBe(true);
		expect(texts.some((text) => text.includes("a plain log"))).toBe(false);
	});

	it("records the requests the page made, with their status", async () => {
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);

		const requests = session.requests();
		const json = requests.find((request) => request.url.endsWith("/data.json"));

		expect(json).toBeDefined();
		expect(json?.status).toBe(200);
	});

	it("records a request that failed with no response at all", async () => {
		// A request to a dead host never gets a status. Reporting it as
		// pending forever, or dropping it, both hide the failure a
		// caller is most likely looking for.
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 500 }, 10_000);

		const failed = session
			.requests()
			.find((request) => request.url.includes("127.0.0.1:1"));

		expect(failed).toBeDefined();
		expect(failed?.status).toBeUndefined();
	});

	it("records a 404 as the answer it was, not as a failure", async () => {
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);

		const missing = session
			.requests()
			.find((request) => request.url.endsWith("/missing"));

		expect(missing?.status).toBe(404);
	});

	it("fetches a response body by request, while Chrome still has it", async () => {
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);
		// The last one, not the first. The request log survives
		// navigation on purpose, so by this point in the file the same
		// url appears several times and only the most recent still has
		// a body Chrome will hand back. Taking the first found reported
		// a working call as broken, which is the mistake a caller of
		// this API will make too.
		const matching = session
			.requests()
			.filter((request) => request.url.endsWith("/data.json"));
		const json = matching[matching.length - 1];
		if (!json) throw new Error("fixture did not make the request");

		const fetched = await session.bodyOf(json.id);

		expect(fetched?.body).toContain("ok");
	});

	it("returns nothing for a body Chrome no longer holds", async () => {
		// Asking about a request from a page that is gone is ordinary,
		// not exceptional: the caller is reading a listing that outlived
		// the navigation. It has to answer rather than throw.
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);

		const fetched = await session.bodyOf("no-such-request-id");

		expect(fetched).toBeUndefined();
	});

	it("writes an archive of what it captured", async () => {
		await session.navigate(fixture.url("/noisy"));
		await session.waitFor({ kind: "idle", quietMs: 300 }, 10_000);

		const path = await session.exportHar(session.requests());

		expect(path).toMatch(/\.har$/);
	});

	it("dismisses a dialog by default, so the page is never stuck", async () => {
		// A dialog blocks the page until it is answered. Leaving it up
		// hangs every later call, so the default has to answer it.
		await session.navigate(fixture.url("/dialogs"));

		await session.evaluate("window.ask()");

		const answer = await session.evaluate(
			"document.getElementById('answer').textContent",
		);
		expect(answer.ok && answer.result.value).toBe("false");
	});

	it("accepts dialogs once told to", async () => {
		await session.navigate(fixture.url("/dialogs"));
		session.setDialogPolicy({ accept: true });
		try {
			await session.evaluate("window.ask()");

			const answer = await session.evaluate(
				"document.getElementById('answer').textContent",
			);
			expect(answer.ok && answer.result.value).toBe("true");
		} finally {
			session.setDialogPolicy({ accept: false });
		}
	});

	it("types into an accepted prompt", async () => {
		await session.navigate(fixture.url("/dialogs"));
		session.setDialogPolicy({ accept: true, promptText: "Ada" });
		try {
			await session.evaluate("window.askText()");

			const answer = await session.evaluate(
				"document.getElementById('answer').textContent",
			);
			expect(answer.ok && answer.result.value).toBe("Ada");
		} finally {
			session.setDialogPolicy({ accept: false });
		}
	});

	it("remembers the dialogs it answered", async () => {
		await session.navigate(fixture.url("/dialogs"));

		await session.evaluate("window.ask()");

		expect(session.dialogs.seen.length).toBeGreaterThan(0);
	});

	it("hears a polite announcement", async () => {
		await session.navigate(fixture.url("/live"));
		// Read once first: the observer is installed on the first ask,
		// and an announcement made before that cannot be heard.
		await session.heard();

		await session.evaluate(
			"document.getElementById('status').textContent = 'Saved your work'",
		);
		await session.waitFor({ kind: "duration", ms: 300 }, 1_000);
		const { entries } = await session.heard();

		expect(entries.map((entry) => entry.item.text)).toContain(
			"Saved your work",
		);
	});

	it("tells an assertive announcement from a polite one", async () => {
		// The difference is the whole point: one interrupts a screen
		// reader user and the other waits its turn.
		await session.navigate(fixture.url("/live"));
		await session.heard();

		await session.evaluate(
			"document.getElementById('alert').textContent = 'Something broke'",
		);
		await session.waitFor({ kind: "duration", ms: 300 }, 1_000);
		const { entries } = await session.heard();

		const broke = entries.find(
			(entry) => entry.item.text === "Something broke",
		);
		expect(broke?.item.politeness).toBe("assertive");
	});

	it("moves its cursor on, so the same announcement is not heard twice", async () => {
		await session.navigate(fixture.url("/live"));
		await session.heard();
		await session.evaluate(
			"document.getElementById('status').textContent = 'Only once'",
		);
		await session.waitFor({ kind: "duration", ms: 300 }, 1_000);

		const first = await session.heard();
		const second = await session.heard(first.cursor);

		expect(first.entries.length).toBeGreaterThan(0);
		expect(second.entries).toHaveLength(0);
	});

	it("has nothing to report about downloads on a page that offered none", async () => {
		await session.navigate(fixture.url("/live"));

		expect(session.downloads()).toEqual([]);
	});
});
