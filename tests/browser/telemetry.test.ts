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
import { strandedByCrash } from "../../lib/web/telemetry/index.js";
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

/**
 * A page that opens a socket, says something and waits to be
 * answered, which is the shape of every live feature.
 */
const SOCKET_PAGE = page(
	"Socket",
	`<main><p id="heard">nothing yet</p></main>
	<script>
		const socket = new WebSocket("ws://" + location.host + "/feed");
		socket.addEventListener("open", () => socket.send("subscribe"));
		socket.addEventListener("message", (event) => {
			document.getElementById("heard").textContent = event.data;
		});
	</script>`,
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
		fixture = await serve(
			[
				{ path: "/noisy", body: NOISY },
				{ path: "/data.json", body: '{"ok":true}', type: "application/json" },
				{ path: "/dialogs", body: DIALOGS },
				{ path: "/live", body: LIVE },
				{ path: "/socket", body: SOCKET_PAGE },
			],
			[
				{
					path: "/feed",
					reply: (said) => (said === "subscribe" ? "welcome" : undefined),
				},
			],
		);
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

	it("records both sides of a websocket conversation", async () => {
		// The page subscribes on open and the fixture answers, so a
		// working record has to show a frame going each way. Until
		// sockets were recorded, all of this was invisible: the page
		// issued one request that never finished and nothing else.
		await session.navigate(fixture.url("/socket"));
		await session.waitFor({ kind: "text", text: "welcome" }, 5_000);

		const sockets = session.sockets();
		expect(sockets).toHaveLength(1);
		expect(sockets[0]?.url).toContain("/feed");
		expect(sockets[0]?.frames.map((frame) => frame.direction)).toEqual([
			"sent",
			"received",
		]);
		expect(sockets[0]?.frames[0]?.payload).toBe("subscribe");
		expect(sockets[0]?.frames[1]?.payload).toBe("welcome");
		// Still open, which is the normal state of a live feature and
		// the one a closed-only report would get wrong.
		expect(sockets[0]?.closedAt).toBeUndefined();
	});

	it("sees memory the page will not let go of", async () => {
		// A leak is the one fault none of the other instruments here
		// can see, so this holds a big array from a global that a
		// collection cannot reclaim, and asks whether the growth shows
		// through a forced collection.
		await session.navigate(fixture.url("/noisy"));
		const first = await session.heap();
		expect(first.direction).toBe("unknown");
		expect(first.now.collected).toBe(true);
		// A zero here is the failure this instrument is most likely to
		// have: the metrics domain answers every value as zero until it
		// is enabled, which reads as a page holding no memory and never
		// changing, so every leak check passes.
		expect(first.now.usedBytes).toBeGreaterThan(0);

		// Objects rather than a typed array: a Uint8Array's backing
		// store is external memory and does not show in the JS heap, so
		// the obvious fixture measures nothing.
		await session.evaluate(
			"window.__held = Array.from({length: 400000}, (_, i) => " +
				"({ i, s: 'x'.repeat(40) })); 'held'",
		);

		const second = await session.heap();
		expect(second.trustworthy).toBe(true);
		expect(second.direction).toBe("grew");
		// Measured at about 41MB, so twenty is a floor that proves the
		// reading follows the page rather than reporting a constant.
		expect(second.grewBy ?? 0).toBeGreaterThan(20 * 1024 * 1024);
	});

	it("lets go of memory nothing is holding", async () => {
		// The other half: without this, a reading that only ever grows
		// would pass the test above while measuring nothing real.
		await session.navigate(fixture.url("/noisy"));
		await session.evaluate(
			"window.__held = Array.from({length: 400000}, (_, i) => " +
				"({ i, s: 'x'.repeat(40) })); 'held'",
		);
		await session.heap();

		await session.evaluate("delete window.__held; 'dropped'");
		const after = await session.heap();

		expect(after.direction).toBe("fell");
	});

	it("has nothing to report about downloads on a page that offered none", async () => {
		await session.navigate(fixture.url("/live"));

		expect(session.downloads()).toEqual([]);
	});
});

const OFFERS_FILE = page(
	"Offers a file",
	'<main><a id="get" href="/file.txt" download>Get the file</a></main>',
);

/** Poll until the browser has caught up, or give up saying so. */
async function until(
	condition: () => boolean,
	what: string,
	budgetMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/**
 * What a session can still hear after its tab has been replaced.
 *
 * Every watcher is bound to a protocol channel that dies with the
 * tab, so recovery has to reinstall all of them. Two were missed,
 * and the failure is silent in the worst way: the session answers
 * normally while no longer noticing a whole class of event, so a
 * caller reads an empty download list and concludes the page
 * offered nothing.
 */
describe.skipIf(!haveChrome)("a session whose tab crashed", () => {
	let fixture: Fixture;

	beforeAll(async () => {
		fixture = await serve([
			{ path: "/offers", body: OFFERS_FILE },
			{
				path: "/file.txt",
				body: "the bytes the page handed back",
				type: "text/plain",
				headers: { "content-disposition": "attachment; filename=file.txt" },
			},
		]);
	});

	afterAll(async () => {
		await fixture?.close();
	});

	it("can still be navigated after the tab is replaced", async () => {
		const session = await BrowserSession.open("crash-navigate");
		try {
			await session.navigate(fixture.url("/offers"));
			await session.navigate("chrome://crash");
			const after = await session.navigate(fixture.url("/offers"));

			// The navigation lands rather than being delivered to the
			// corpse, so it reports no failure and the session is where
			// it was asked to go.
			expect(after.failure).toBeUndefined();
			expect((await session.status()).url).toBe(fixture.url("/offers"));
		} finally {
			await session.close();
		}
	});

	it("tells a blank replacement tab from a page with nothing on it", async () => {
		const session = await BrowserSession.open("crash-stranded");
		try {
			await session.navigate(fixture.url("/offers"));
			expect(strandedByCrash(session.history)).toBe(false);

			await session.navigate("chrome://crash");
			// The abort comes back in about a millisecond and Chrome
			// announces the crash a second or so later, so the reading
			// has to wait for the announcement rather than assume it.
			await until(
				() => strandedByCrash(session.history),
				"the crash to be announced and the tab replaced",
			);

			// Going somewhere is what ends it. A session parked on a
			// blank page it chose is not stranded on one.
			await session.navigate(fixture.url("/offers"));
			expect(strandedByCrash(session.history)).toBe(false);
		} finally {
			await session.close();
		}
	});

	it("still notices a download after the tab is replaced", async () => {
		const session = await BrowserSession.open("telemetry-crash");
		try {
			const fetchOnce = async (): Promise<void> => {
				await session.navigate(fixture.url("/offers"));
				await session.act({
					kind: "click",
					target: { role: "link", name: "Get the file" },
				});
			};

			// Prove the listener works before the crash, so a failure
			// afterwards is about recovery and not about the fixture.
			await fetchOnce();
			await until(
				() => session.downloads().length > 0,
				"the first download to be recorded",
			);
			const before = session.downloads().length;

			// Killing the renderer is the whole point. The navigation
			// that does it answers with the abort rather than throwing.
			await session.navigate("chrome://crash");

			await fetchOnce();
			await until(
				() => session.downloads().length > before,
				"a download recorded after the tab was replaced",
			);
		} finally {
			await session.close();
		}
	});
});
