/** The bash calls a park carried: whether each still runs, their record, and the wake once they end. */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CALLS_WATCHED_MS,
	callRuns,
	carriedCalls,
	keepCarriedCalls,
	watchCarriedCalls,
} from "../../../host/engine/parked-calls.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import { KEPT_BYTES } from "../../../lib/internal/shell/kept.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import { until } from "../../support/until.ts";

/** How often a test's watch looks at the calls. */
const LOOK_MS = 10;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "parked-calls-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A call of this test process, whose environment carries its mark when `marked`. */
function call(name: string, over: Partial<CarriedShell> = {}): CarriedShell {
	return {
		kind: "shell",
		keep: join(dir, name),
		pid: process.pid,
		mark: process.env[CALL_VARIABLE] ?? `no-mark-${name}`,
		startedAt: Date.now(),
		...over,
	};
}

describe("whether a carried call still runs", () => {
	// /proc/<pid>/environ of this process holds its own mark only when a
	// bash call started it, so the mark is read as the process says.
	const ownMark = process.env[CALL_VARIABLE];

	it.runIf(ownMark !== undefined)(
		"runs while its shell is there with its mark",
		() => {
			expect(callRuns(call("live"))).toBe(true);
		},
	);

	it("has ended once its end is written, its shell there or not", () => {
		const ended = call("ended");
		writeFileSync(`${ended.keep}.end`, "0\n");
		expect(callRuns(ended)).toBe(false);
	});

	it("has ended once its shell is gone, or another process holds its pid", () => {
		expect(callRuns(call("gone", { pid: 2 ** 22 + 1 })), "no such pid").toBe(
			false,
		);
		expect(
			callRuns(call("reused", { mark: "a-mark-nothing-carries" })),
			"this process, without the call's mark",
		).toBe(false);
	});

	it("has ended past its time limit, or a day after it started, so its conversation wakes", () => {
		const now = Date.now();
		expect(callRuns(call("late", { deadline: now - 1 }), now)).toBe(false);
		expect(
			callRuns(call("old", { startedAt: now - CALLS_WATCHED_MS }), now),
		).toBe(false);
	});
});

describe("the record of the calls a park carried", () => {
	it("adds each carry to what the park already recorded", () => {
		keepCarriedCalls(dir, [call("one")]);
		keepCarriedCalls(dir, [call("two")]);
		expect(carriedCalls(dir).map((work) => work.keep)).toEqual([
			join(dir, "one"),
			join(dir, "two"),
		]);
	});

	it("reads none from a record cut off or not a list, and passes over what isn't a call", () => {
		writeFileSync(join(dir, "carried-calls.json"), "[{");
		expect(carriedCalls(dir)).toEqual([]);
		writeFileSync(join(dir, "carried-calls.json"), '{"a":1}');
		expect(carriedCalls(dir)).toEqual([]);
		writeFileSync(
			join(dir, "carried-calls.json"),
			JSON.stringify([{ kind: "shell" }, call("whole")]),
		);
		expect(carriedCalls(dir).map((work) => work.keep)).toEqual([
			join(dir, "whole"),
		]);
	});
});

describe("watching the calls a park carried", () => {
	it("writes the wake once a write can land, trying again at each look", async () => {
		keepCarriedCalls(dir, [call("ended")]);
		const folder = join(dir, "not-yet");
		const wakeFile = join(folder, "wake");
		const reported: unknown[] = [];
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile,
			runs: () => false,
			lookEveryMs: LOOK_MS,
			report: (error) => reported.push(error),
		});
		try {
			expect(reported.length, "the first write fails").toBeGreaterThan(0);
			mkdirSync(folder);
			await until("the wake to be written", () => existsSync(wakeFile));
			expect(JSON.parse(readFileSync(wakeFile, "utf8")).why).toBe(
				"the bash calls its park carried ended",
			);
		} finally {
			stop();
		}
	});

	it("rolls a running call's output as its conversation would", async () => {
		const chatty = call("chatty");
		keepCarriedCalls(dir, [chatty]);
		writeFileSync(`${chatty.keep}.out`, Buffer.alloc(KEPT_BYTES + 1));
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile: join(dir, "wake"),
			runs: () => true,
			lookEveryMs: LOOK_MS,
			report: () => {},
		});
		try {
			await until(
				"its output to roll",
				() => statSync(`${chatty.keep}.out`).size <= KEPT_BYTES,
			);
			expect(existsSync(join(dir, "wake")), "still running").toBe(false);
		} finally {
			stop();
		}
	});
});
