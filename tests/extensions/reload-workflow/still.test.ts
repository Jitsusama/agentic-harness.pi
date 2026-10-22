/**
 * A reload waits for the session to be still, not merely idle: a run
 * a compaction cut short is resumed a moment after it ends, and a
 * reload in that gap pulls the tools from under the resumed run.
 */

import { describe, expect, it } from "vitest";
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

describe("waiting for the session to be still", () => {
	it("waits out a run resumed just after the last one ended", async () => {
		const session = resumedAfterItEnds();
		let still = false;

		const waiting = untilStill(session.ctx, STILL_MS).then(() => {
			still = true;
		});
		await new Promise((done) => setTimeout(done, STILL_MS * 3));
		expect(still).toBe(false);

		session.finish();
		await waiting;
		expect(session.waits()).toBe(2);
	});

	it("goes on at once from a session that stays idle", async () => {
		const ctx = {
			isIdle: () => true,
			hasPendingMessages: () => false,
			waitForIdle: async () => {},
		};
		await expect(untilStill(ctx, STILL_MS)).resolves.toBeUndefined();
	});
});
