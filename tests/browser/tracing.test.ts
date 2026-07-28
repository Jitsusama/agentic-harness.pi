import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderTrace } from "../../lib/web/perf/index.js";
import {
	claimRecording,
	releaseRecording,
} from "../../lib/web/session/recording.js";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

/**
 * A button whose handler schedules the work we want explained: two
 * timers, and two fetches that deliberately settle in the opposite
 * order to the one they were sent in.
 */
const CAUSAL = page(
	"Causal",
	`<main><h1>Causal</h1><button type="button" id="go">Go</button></main>
<script>
document.getElementById("go").addEventListener("click", function () {
  setTimeout(function () { fetch("/slow"); }, 20);
  setTimeout(function () { fetch("/quick"); }, 40);
});
</script>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("recording a trace, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/causal", body: CAUSAL },
			{ path: "/slow", body: "{}", type: "application/json", delayMs: 350 },
			{ path: "/quick", body: "{}", type: "application/json" },
		]);
		session = await BrowserSession.open("tracing-contract");
		await session.navigate(fixture.url("/causal"));
	});

	afterAll(async () => {
		releaseRecording();
		await session?.close();
		await fixture?.close();
	});

	it("explains what the click set in motion", async () => {
		const recorded = await session.recordWhile(["async"], async () => {
			const clicked = await session.act({
				kind: "click",
				target: { role: "button", name: "Go" },
			});
			// Long enough for both timers to fire and both fetches to
			// settle, so the causal chain is complete inside the window.
			await new Promise((wake) => setTimeout(wake, 700));
			return clicked;
		});

		expect(recorded.result.ok).toBe(true);
		expect(recorded.refusal).toBeUndefined();
		const trace = recorded.trace;
		if (trace === undefined) throw new Error("expected a trace");

		// The timers were installed inside the recording, which is the
		// whole reason the work runs inside it rather than before.
		expect(trace.timers.length).toBeGreaterThanOrEqual(2);
		expect(
			trace.timers.filter((timer) => timer.firedCount > 0).length,
		).toBeGreaterThanOrEqual(2);

		// Both fetches are joined to their sends by request id, so the
		// urls are known rather than being bare ids.
		const urls = trace.requests.map((request) => request.url ?? "");
		expect(urls.some((url) => url.includes("/slow"))).toBe(true);
		expect(urls.some((url) => url.includes("/quick"))).toBe(true);
	});

	it("notices the quick request answering before the slow one", async () => {
		const recorded = await session.recordWhile(["async"], async () => {
			await session.act({
				kind: "click",
				target: { role: "button", name: "Go" },
			});
			await new Promise((wake) => setTimeout(wake, 700));
		});
		const trace = recorded.trace;
		if (trace === undefined) throw new Error("expected a trace");

		// /slow is asked for first and takes 350ms; /quick is asked for
		// second and answers at once. That is the fact a waterfall
		// hides and the reason this is worth reporting at all.
		expect(trace.overlapping).toBeGreaterThanOrEqual(2);
		expect(trace.resolvedOutOfOrder).toBe(true);
	});

	it("attributes the work to this page and nothing else", async () => {
		const recorded = await session.recordWhile(["async"], async () => {
			await session.act({
				kind: "click",
				target: { role: "button", name: "Go" },
			});
			await new Promise((wake) => setTimeout(wake, 400));
		});
		const trace = recorded.trace;
		if (trace === undefined) throw new Error("expected a trace");

		expect(trace.mine).toBeGreaterThan(0);
		// Every request we kept must belong to our own fixture.
		for (const request of trace.requests) {
			expect(request.url ?? fixture.url("/causal")).toContain(
				new URL(fixture.url("/causal")).host,
			);
		}
	});

	it("counts frames when asked, and says whose they are", async () => {
		const recorded = await session.recordWhile(["frames"], async () => {
			await session.evaluate(
				"(() => { let n = 0; const step = () => { n += 1; " +
					"document.body.style.transform = 'translateX(' + (n % 20) + 'px)'; " +
					"if (n < 30) requestAnimationFrame(step); }; " +
					"requestAnimationFrame(step); })()",
			);
			await new Promise((wake) => setTimeout(wake, 700));
		});
		const trace = recorded.trace;
		if (trace === undefined) throw new Error("expected a trace");

		expect(trace.frames).toBeDefined();
		expect(trace.frames?.counted).toBeGreaterThan(0);
		// Measured: one page alone reports exactly one contributing
		// layer tree, so the report can say the frames are this page's
		// instead of hedging. It used to hedge unconditionally.
		expect(trace.frames?.layerTrees).toBe(1);
		expect(renderTrace(trace)).toContain("this page's frames");
		expect(renderTrace(trace)).not.toMatch(/another page/i);

		// The other branch, where several layer trees contribute, is
		// covered by unit tests against real-shaped events rather than
		// here. Driving it live was tried and abandoned: opening a second
		// page focuses it, which throttles this page's animation frames
		// away, so the recording came back with three events and proved
		// nothing. Chrome also gave the second page its own renderer, so
		// the shared-process case was not even reproduced.
	});

	it("refuses a second recording and names the session holding it", async () => {
		// The browser allows one trace at a time; measured, a second
		// Tracing.start is refused outright. So the permit is claimed
		// here to stand in for another session already recording.
		claimRecording("someone-else", ["async"]);
		try {
			const recorded = await session.recordWhile(["async"], async () =>
				session.act({
					kind: "click",
					target: { role: "button", name: "Go" },
				}),
			);

			// The action still happened. Losing the trace must never
			// cost the caller the thing they asked for.
			expect(recorded.result.ok).toBe(true);
			expect(recorded.trace).toBeUndefined();
			expect(recorded.refusal).toContain("someone-else");
		} finally {
			releaseRecording();
		}
	});

	it("gives the permit back after each recording", async () => {
		// The control for the refusal above, and it has to record twice
		// in a row with no release of its own in between. Asserting a
		// single recording works proves nothing here: the test before
		// this one releases the permit in its own cleanup, so a
		// recordWhile that never released would still look fine.
		const first = await session.recordWhile(["async"], async () => {
			await new Promise((wake) => setTimeout(wake, 50));
		});
		const second = await session.recordWhile(["async"], async () => {
			await new Promise((wake) => setTimeout(wake, 50));
		});

		expect(first.refusal).toBeUndefined();
		expect(first.trace).toBeDefined();
		expect(second.refusal).toBeUndefined();
		expect(second.trace).toBeDefined();
	});

	it("tells a bystander session that tracing is costing them", async () => {
		claimRecording("someone-else", ["async", "frames"]);
		try {
			const status = await session.status();

			expect(status.recording).toContain("someone-else");
			expect(status.recording).toMatch(/every page/i);
		} finally {
			releaseRecording();
		}
	});

	it("says nothing about recording when none is running", async () => {
		const status = await session.status();

		expect(status.recording).toBeUndefined();
	});
});
