/**
 * What the supervisor says of a stop: the state, the exit code a run
 * gets when its child gave none, and the warning naming the limit.
 */

import { describe, expect, it } from "vitest";
import {
	fallbackExitCode,
	stateForClose,
	stopWarning,
} from "../../../../lib/subagent/runpi/supervisor-stops.mjs";

const limits = { timeoutMs: 600, idleTimeoutMs: 300, softDeadlineMs: 500 };

describe("a stop", () => {
	it("ends a closed child in its reason, else by its exit", () => {
		expect(stateForClose("cancelled", 0)).toBe("cancelled");
		expect(stateForClose(null, 0)).toBe("complete");
		expect(stateForClose(null, 1)).toBe("failed");
		expect(stateForClose(null, null)).toBe("failed");
	});

	it("gives a deadline 124, a cancel or a parent gone 130, else 1", () => {
		for (const reason of ["timeout", "idle-timeout", "soft-deadline"] as const)
			expect(fallbackExitCode(reason)).toBe(124);
		expect(fallbackExitCode("cancelled")).toBe(130);
		expect(fallbackExitCode("parent-exit")).toBe(130);
		expect(fallbackExitCode(null)).toBe(1);
	});

	it("names the limit it reached", () => {
		expect(stopWarning("timeout", limits)).toBe(
			"Pi subprocess timed out after 600ms; sent SIGTERM.",
		);
		expect(stopWarning("idle-timeout", limits)).toBe(
			"Pi subprocess idle for 300ms; sent SIGTERM.",
		);
		expect(stopWarning("soft-deadline", limits)).toBe(
			"Pi subprocess reached its soft deadline of 500ms with 600ms allowed in total; sent SIGTERM so the rest of the budget can be spent asking for its answer.",
		);
		expect(stopWarning("parent-exit", limits)).toBe(
			"Pi parent process exited; sent SIGTERM.",
		);
		expect(stopWarning("cancelled", limits)).toBe(
			"Pi subprocess cancelled; sent SIGTERM.",
		);
	});
});
