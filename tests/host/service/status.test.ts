/** What a host says of itself in words, for systemd and the journal. */

import { describe, expect, it } from "vitest";
import {
	describeStep,
	droppedNames,
	phaseTimes,
	readyCount,
	readyStatus,
	stoppingStatus,
} from "../../../host/service/status.ts";

describe("describeStep", () => {
	it("names the last host waited on, the engine, and which conversation of how many", () => {
		expect(describeStep({ step: "roster", holder: 41 })).toBe(
			"waiting on the last host, pid 41, to let go of the roster",
		);
		expect(describeStep({ step: "engine" })).toBe("building the engine");
		expect(
			describeStep({ step: "resume", number: 2, of: 5, sessionId: "s" }),
		).toBe("resuming 2 of 5: s");
	});
});

describe("readyStatus", () => {
	it("says how many it loaded, left parked and dropped, and any held but not resumed", () => {
		const none = { loaded: 0, parked: 0, dropped: 0, unresumed: 0 };
		expect(readyStatus(none)).toBe("ready: loaded 0, parked 0, dropped 0");
		const some = { loaded: 3, parked: 2, dropped: 32, unresumed: 1 };
		expect(readyStatus(some)).toBe(
			"ready: loaded 3, parked 2, dropped 32, 1 held but not resumed",
		);
	});
});

describe("stoppingStatus", () => {
	it("says how many it parks, in words for none, one and more", () => {
		expect(stoppingStatus(0)).toBe("stopping, parking no conversations");
		expect(stoppingStatus(1)).toBe("stopping, parking 1 conversation");
		expect(stoppingStatus(2)).toBe("stopping, parking 2 conversations");
	});
});

describe("readyCount", () => {
	it("counts a resume that failed once it registered as not resumed, never as parked", () => {
		const since = "2026-11-17T05:07:00.000Z";
		const count = readyCount({
			held: () => [
				{ id: "awake", state: "idle", since },
				{ id: "asleep", state: "parked", since },
				{ id: "failed", state: "parked", since },
			],
			unresumed: [{ sessionId: "failed", reason: new Error("no") }],
			dropped: ["gone"],
			resting: () => 2,
			stillUnresumed: () => 1,
		});
		expect(count).toEqual({ loaded: 1, parked: 3, dropped: 1, unresumed: 1 });
	});
});

describe("droppedNames", () => {
	it("names the holds a start dropped, for the journal, and nothing when none", () => {
		expect(droppedNames([])).toBe("");
		expect(droppedNames(["a", "b"])).toBe(
			" (dropped, their session files gone: a, b)",
		);
	});
});

describe("phaseTimes", () => {
	it("puts each phase's time in words, and what followed the last", () => {
		expect(
			phaseTimes(
				1_000,
				[
					{ phase: "ask", at: 1_000 },
					{ phase: "gate", at: 1_100 },
					{ phase: "recovery", at: 3_600 },
				],
				65_000,
			),
		).toBe(" (ask 0.0 s, gate 0.1 s, recovery 2.5 s, rest 61.4 s)");
		expect(phaseTimes(1_000, [], 2_000), "none marked").toBe("");
	});
});
