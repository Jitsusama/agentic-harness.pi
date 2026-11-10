/**
 * A reload waits for the session to be still, not merely idle: a run
 * a compaction cut short is resumed a moment after it ends, and a
 * reload in that gap pulls the tools from under the resumed run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untilStill } from "../../../extensions/reload-workflow/transitions.ts";

const STILL_MS = 20;

/** A session whose run ends now and is resumed a few milliseconds later. */
function resumedAfterItEnds() {
	let busy = false;
	let queued = false;
	let waits = 0;
	let finishResumed: () => void = () => {};
	const ctx = {
		isIdle: () => !busy,
		hasPendingMessages: () => queued,
		waitForIdle: async () => {
			waits += 1;
			if (waits === 1) {
				// The cut-short run has just ended; its resume is on its way.
				setTimeout(() => {
					queued = true;
				}, 5);
				setTimeout(() => {
					queued = false;
					busy = true;
				}, 10);
				return;
			}
			await new Promise<void>((done) => {
				finishResumed = () => {
					busy = false;
					done();
				};
			});
		},
	};
	return { ctx, finish: () => finishResumed(), waits: () => waits };
}

// The wait is timers alone, so a driven clock says exactly what holds
// after each span, however busy the machine is.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("waiting for the session to be still", () => {
	it("waits out a run resumed just after the last one ended", async () => {
		const session = resumedAfterItEnds();
		let still = false;

		const waiting = untilStill(session.ctx, STILL_MS).then(() => {
			still = true;
		});
		await vi.advanceTimersByTimeAsync(STILL_MS * 3);
		expect({ still }, "the wait holds while the resumed run goes on").toEqual({
			still: false,
		});

		session.finish();
		await vi.advanceTimersByTimeAsync(STILL_MS);
		await waiting;
		expect(session.waits()).toBe(2);
	});

	it("goes on at once from a session that stays idle", async () => {
		const ctx = {
			isIdle: () => true,
			hasPendingMessages: () => false,
			waitForIdle: async () => {},
		};
		const waiting = untilStill(ctx, STILL_MS);
		await vi.advanceTimersByTimeAsync(STILL_MS);
		await expect(waiting).resolves.toBe(0);
	});

	it("waits for a run under way even when pi calls the session idle", async () => {
		// What the logs of 22 October show: the reload passed this wait
		// while a resumed run's first reply was streaming.
		const ctx = {
			isIdle: () => true,
			hasPendingMessages: () => false,
			waitForIdle: async () => {},
		};
		let underWay = true;
		let still = false;

		const waiting = untilStill(ctx, STILL_MS, () => underWay).then((n) => {
			still = true;
			return n;
		});
		await vi.advanceTimersByTimeAsync(STILL_MS * 4);
		expect({ still }, "the wait holds while a run is under way").toEqual({
			still: false,
		});

		underWay = false;
		await vi.advanceTimersByTimeAsync(STILL_MS);
		expect(await waiting).toBeGreaterThan(0);
	});
});
