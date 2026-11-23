/** What a host says of itself in words, for systemd and the journal. */

import { describe, expect, it } from "vitest";
import {
	describeStep,
	droppedNames,
	phaseTimes,
	readyCount,
	readyStatus,
	startLine,
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

	it("says how many run in processes of their own, when any do", () => {
		const apart = { loaded: 1, parked: 2, dropped: 0, unresumed: 0 };
		expect(readyStatus({ ...apart, children: 4 })).toBe(
			"ready: loaded 1, parked 2, 4 in processes of their own, dropped 0",
		);
		expect(readyStatus({ ...apart, children: 0 })).toBe(
			"ready: loaded 1, parked 2, dropped 0",
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
		expect(count).toEqual({
			loaded: 1,
			parked: 3,
			dropped: 1,
			unresumed: 1,
			children: 0,
		});
	});

	it("counts the conversations children run apart from those the host runs", () => {
		const count = readyCount({
			held: () => [],
			unresumed: [],
			dropped: [],
			resting: () => 0,
			stillUnresumed: () => 0,
			inChildren: () => 3,
		});
		expect(count).toMatchObject({ loaded: 0, parked: 0, children: 3 });
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

describe("startLine", () => {
	const id = "01a209c3-fefb-760c-8962-a4ae65735570";

	it("says how long an open took, and each phase, under its address and id", () => {
		expect(
			startLine(
				id,
				{ op: "open" },
				1_000,
				[
					{ phase: "prepare", at: 1_200 },
					{ phase: "services", at: 6_200 },
				],
				9_000,
			),
		).toBe(
			`65735570 (${id}): its open took 8.0 s (prepare 0.2 s, services 5.0 s, rest 2.8 s)`,
		);
	});

	it("says one that failed before pi named it as not yet named", () => {
		expect(startLine(undefined, { op: "adopt" }, 1_000, [], 1_500)).toBe(
			"A conversation not yet named: its adopt took 0.5 s",
		);
	});
});
