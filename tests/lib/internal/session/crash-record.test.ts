import { afterEach, describe, expect, it } from "vitest";
import { processGlobal } from "../../../../lib/internal/process-global.ts";
import {
	CRASH_SLOT,
	type Crash,
	crashOf,
	crashText,
	recordCrashes,
} from "../../../../lib/internal/session/crash-record.ts";

const MONITOR = "uncaughtExceptionMonitor";

/**
 * Calls the listener this module put on the process, as Node does just
 * before a crash, leaving alone any the test runner keeps.
 */
function crash(error: unknown, origin = "uncaughtException"): void {
	const slot = processGlobal<{ listener?: unknown }>(CRASH_SLOT, () => ({}));
	const { listener } = slot;
	if (typeof listener !== "function") throw new Error("no listener");
	const listeners = process.listeners(MONITOR);
	expect(listeners, "the listener is on the process").toContain(listener);
	listener(error, origin);
}

describe("recordCrashes", () => {
	const stops: (() => void)[] = [];
	afterEach(() => {
		for (const stop of stops.splice(0)) stop();
	});

	it("tells each session's writer of a throw and of a rejection nothing handled", () => {
		const first: Crash[] = [];
		const second: Crash[] = [];
		stops.push(recordCrashes("a", (c) => first.push(c)));
		stops.push(recordCrashes("b", (c) => second.push(c)));

		crash(new Error("ESRCH: no such process, write"), "unhandledRejection");

		expect(first.map((c) => [c.origin, c.message])).toEqual([
			["unhandledRejection", "ESRCH: no such process, write"],
		]);
		expect(second, "the other session hears it too").toHaveLength(1);
		expect(first[0]?.stack, "the stack is kept").toContain("Error: ESRCH");
	});

	it("keeps one listener however often a load replaces it", () => {
		const before = process.listenerCount(MONITOR);
		const told: string[] = [];
		stops.push(recordCrashes("a", () => told.push("old load")));
		stops.push(recordCrashes("a", () => told.push("new load")));
		stops.push(recordCrashes("b", () => told.push("other session")));

		expect(process.listenerCount(MONITOR)).toBe(before + 1);
		crash(new Error("boom"));
		expect(told).toEqual(["new load", "other session"]);
	});

	it("lets the next writer write when one throws", () => {
		const told: string[] = [];
		stops.push(
			recordCrashes("a", () => {
				throw new Error("can't write");
			}),
		);
		stops.push(recordCrashes("b", () => told.push("b")));
		crash(new Error("boom"));
		expect(told).toEqual(["b"]);
	});

	it("leaves the newer writer when an older load stops after it", () => {
		const told: string[] = [];
		const older = recordCrashes("a", () => told.push("older"));
		stops.push(recordCrashes("a", () => told.push("newer")));
		older();
		crash(new Error("boom"));
		expect(told).toEqual(["newer"]);
	});

	it("takes its listener away once no writer is left", () => {
		const before = process.listenerCount(MONITOR);
		const stopA = recordCrashes("a", () => {});
		const stopB = recordCrashes("b", () => {});
		stopA();
		expect(process.listenerCount(MONITOR)).toBe(before + 1);
		stopB();
		expect(process.listenerCount(MONITOR)).toBe(before);
	});
});

describe("crashOf", () => {
	it("says what was thrown when it is no error", () => {
		const at = new Date("2026-11-11T08:36:11.224Z");
		expect(crashOf("plain", "uncaughtException", at)).toEqual({
			at: "2026-11-11T08:36:11.224Z",
			origin: "uncaughtException",
			message: "plain",
		});
	});
});

describe("crashText", () => {
	it("names whose it was, then the stack", () => {
		const text = crashText(
			{
				at: "2026-11-11T08:36:11.224Z",
				origin: "unhandledRejection",
				message: "gone",
				stack: "Error: gone\n    at write",
			},
			"session 01a1 in /src/x",
		);
		expect(text).toBe(
			"pi session 01a1 in /src/x is ending on an uncaught error (unhandledRejection) at 2026-11-11T08:36:11.224Z: gone\nError: gone\n    at write",
		);
	});
});
