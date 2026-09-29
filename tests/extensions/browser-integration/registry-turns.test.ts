/**
 * Browser calls take turns on a session, can be stopped, and keep their
 * session alive while they run.
 *
 * Parallel calls on one session interleaved on the same page, so a click
 * could land mid-navigation. A call could not be stopped, so Escape left
 * the turn waiting on the browser. And the idle reaper judged a session
 * by the last thing it did, which a call sitting inside one long wait
 * never updates, so a session could close under a call still using it.
 */

import type { BrowserSession } from "@jitsusama/agentic-harness.core/web/session";
import { describe, expect, it } from "vitest";
import { createSessionRegistry } from "../../../extensions/browser-integration/registry.ts";

/** Long enough that a call nothing held back would plainly have run. */
const SETTLED_WITHIN_MS = 200;
/** A reaper clock short enough for a test to watch it fire. */
const IDLE_MS = 20;

/** A promise the test settles, to stand for a browser call in flight. */
function pending<T = void>() {
	let settle: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session that never does anything, so only a call keeps it in use. */
function quietSession() {
	const state = { closed: false };
	const session = {
		lastUsedAt: 0,
		close: async () => {
			state.closed = true;
		},
	} as unknown as BrowserSession;
	return { session, state };
}

function registryOver(session: BrowserSession) {
	return createSessionRegistry({
		open: async () => session,
		idleTimeoutMs: IDLE_MS,
	});
}

describe("calls on a browser session", () => {
	it("take turns on one session", async () => {
		const registry = registryOver(quietSession().session);
		const first = pending();
		const started: string[] = [];

		const one = registry.use("s", undefined, async () => {
			started.push("first");
			await first.promise;
		});
		const two = registry.use("s", undefined, async () => {
			started.push("second");
		});
		await pause(SETTLED_WITHIN_MS);
		const whileFirstRan = [...started];
		first.settle();
		await Promise.all([one, two]);

		expect(whileFirstRan).toEqual(["first"]);
		expect(started).toEqual(["first", "second"]);
	});

	it("run side by side on different sessions", async () => {
		const registry = registryOver(quietSession().session);
		const first = pending();
		const started: string[] = [];

		const one = registry.use("a", undefined, async () => {
			started.push("a");
			await first.promise;
		});
		const two = registry.use("b", undefined, async () => {
			started.push("b");
		});
		await pause(SETTLED_WITHIN_MS);
		const whileFirstRan = [...started];
		first.settle();
		await Promise.all([one, two]);

		expect(whileFirstRan).toEqual(["a", "b"]);
	});

	it("answer a stop at once, and the next call waits out the one abandoned", async () => {
		const registry = registryOver(quietSession().session);
		const browser = pending();
		const stop = new AbortController();
		let nextRan = false;

		const stopped = registry
			.use("s", stop.signal, () => browser.promise)
			.catch((error: Error) => error);
		const next = registry.use("s", undefined, async () => {
			nextRan = true;
		});
		await pause(1);
		stop.abort();

		const answered = await Promise.race([
			stopped,
			pause(SETTLED_WITHIN_MS).then(() => "still running"),
		]);
		await pause(SETTLED_WITHIN_MS);
		const nextRanBeforeBrowserAnswered = nextRan;
		browser.settle();
		await next;

		expect(answered).toMatchObject({ name: "AbortError" });
		expect(nextRanBeforeBrowserAnswered).toBe(false);
		expect(nextRan).toBe(true);
	});

	it("leave the queue unrun when stopped while waiting their turn", async () => {
		const registry = registryOver(quietSession().session);
		const first = pending();
		const stop = new AbortController();
		let waiterRan = false;

		const one = registry.use("s", undefined, () => first.promise);
		const waiter = registry
			.use("s", stop.signal, async () => {
				waiterRan = true;
			})
			.catch((error: Error) => error);
		await pause(1);
		stop.abort();

		const answered = await Promise.race([
			waiter,
			pause(SETTLED_WITHIN_MS).then(() => "still waiting"),
		]);
		first.settle();
		await one;
		await pause(IDLE_MS);

		expect(answered).toMatchObject({ name: "AbortError" });
		expect(waiterRan).toBe(false);
	});

	it("refuse a call already stopped without running it", async () => {
		const registry = registryOver(quietSession().session);
		let ran = false;

		const answered = await registry
			.use("s", AbortSignal.abort(), async () => {
				ran = true;
			})
			.catch((error: Error) => error);

		expect(answered).toMatchObject({ name: "AbortError" });
		expect(ran).toBe(false);
	});

	it("keep their session open however long they run", async () => {
		const { session, state } = quietSession();
		const registry = registryOver(session);
		const call = pending();

		await registry.acquire("s");
		const running = registry.use("s", undefined, () => call.promise);
		await pause(IDLE_MS * 10);
		const closedWhileRunning = state.closed;
		call.settle();
		await running;
		await pause(IDLE_MS * 10);

		expect(closedWhileRunning).toBe(false);
		expect(state.closed).toBe(true);
	});

	it("leave their session a full idle stretch after they finish", async () => {
		// The reaper looks at 200ms and finds the call running, so it
		// looks again at 400ms. The call ends at 350ms; closing at 400ms
		// would give the caller 50ms, not the stretch it was promised.
		const idleMs = 200;
		const endsAtMs = 350;
		const checkedAfterMs = 120;
		const { session, state } = quietSession();
		const registry = createSessionRegistry({
			open: async () => session,
			idleTimeoutMs: idleMs,
		});

		await registry.acquire("s");
		await registry.use("s", undefined, () => pause(endsAtMs));
		await pause(checkedAfterMs);
		const closedSoonAfter = state.closed;
		await pause(idleMs);

		expect(closedSoonAfter).toBe(false);
		expect(state.closed).toBe(true);
	});
});
