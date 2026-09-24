import { describe, expect, it } from "vitest";
import {
	FAILURE_ENTRY,
	failureRecord,
	turnsBeforeRetry,
	wasCancelled,
} from "../../../lib/compaction/index.ts";

describe("backing off after a compaction fails", () => {
	it("tries again straight away when nothing has failed", () => {
		expect(turnsBeforeRetry(0)).toBe(0);
	});

	it("waits eight turns after the first failure and doubles after each one since", () => {
		expect([1, 2, 3, 4].map(turnsBeforeRetry)).toEqual([8, 16, 32, 64]);
	});

	it("never waits longer than 128 turns, so a session that grows keeps being offered one", () => {
		expect(turnsBeforeRetry(6)).toBe(128);
		expect(turnsBeforeRetry(40)).toBe(128);
	});
});

describe("telling a cancelled compaction from a failed one", () => {
	it("reads pi's cancellation as the user choosing not to compact", () => {
		expect(wasCancelled(new Error("Compaction cancelled"))).toBe(true);
	});

	it("reads a summary cut off at the token cap as a failure", () => {
		expect(
			wasCancelled(
				new Error(
					"Summarization failed: generation hit the token cap and the summary is incomplete",
				),
			),
		).toBe(false);
	});
});

describe("recording a failed compaction in the session log", () => {
	it("names its own entry type, so a search of the logs finds it", () => {
		expect(FAILURE_ENTRY).toBe("compaction-failed");
	});

	it("keeps the size it failed at, the error, the streak and the wait", () => {
		expect(failureRecord(315_140, new Error("boom"), 2)).toEqual({
			tokens: 315_140,
			error: "boom",
			consecutiveFailures: 2,
			retryAfterTurns: 16,
		});
	});
});
