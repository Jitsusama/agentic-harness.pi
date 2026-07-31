import { describe, expect, it } from "vitest";
// @ts-expect-error - a plain .mjs sibling of the spawned supervisor
// script, which cannot import TypeScript because node runs it directly.
import { clockVerdict } from "../../../../lib/subagent/runpi/watchdog.mjs";

/** A run that started a minute ago and has been quiet for a second. */
const HEALTHY = {
	now: 60_000,
	startedAtMs: 0,
	timeoutMs: 120_000,
	lastActivityAtMs: 59_000,
	idleTimeoutMs: 30_000,
};

describe("what the clock alone can decide", () => {
	it("carries on while both budgets hold", () => {
		expect(clockVerdict(HEALTHY)).toBeNull();
	});

	it("stops a run past its wall clock", () => {
		expect(clockVerdict({ ...HEALTHY, now: 120_001 })).toBe("timeout");
	});

	it("stops a run that has gone quiet", () => {
		expect(clockVerdict({ ...HEALTHY, lastActivityAtMs: 29_999 })).toBe(
			"idle-timeout",
		);
	});

	// Both budgets blown reports the deadline, because a run past its
	// wall clock is over whatever else it was doing, and the more
	// specific reason would understate it.
	it("names the deadline when both are blown", () => {
		expect(
			clockVerdict({ ...HEALTHY, now: 200_000, lastActivityAtMs: 0 }),
		).toBe("timeout");
	});

	// The invariant this module exists for, and the actual fix. The
	// supervisor's deadline used to be evaluated after two `stat` calls
	// that answer an unrelated question, so under I/O pressure the check
	// that must fire was the one most starved: a run at load 168 renewed
	// its lease every second for 145 seconds without ever enforcing its
	// own 120-second timeout. A verdict that cannot await anything
	// cannot be gated on a filesystem that has stopped answering.
	it("decides without awaiting anything", () => {
		const verdict = clockVerdict({ ...HEALTHY, now: 200_000 });

		expect(verdict).not.toBeInstanceOf(Promise);
		expect(clockVerdict.constructor.name).toBe("Function");
	});
});
