/** The bash calls a park carried: whether each still runs, their record, and the wake once they end. */
import { type ChildProcess, spawn } from "node:child_process";
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
	CALLS_WAKE_AGAIN_MOST_MS,
	CALLS_WATCHED_MS,
	callRuns,
	carriedCalls,
	keepCarriedCalls,
	watchCarriedCalls,
} from "../../../host/engine/parked-calls.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import { KEPT_BYTES } from "../../../lib/internal/shell/kept.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import { execed } from "../../support/processes.ts";
import { quietFor, until } from "../../support/until.ts";

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

/** A live shell of a call, carrying `mark`, started for the test. */
function liveCall(name: string): { child: ChildProcess; work: CarriedShell } {
	const mark = `mark-${name}-${process.pid}`;
	const child = spawn("sleep", ["60"], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, [CALL_VARIABLE]: mark },
	});
	if (child.pid === undefined) throw new Error("sleep did not start");
	return { child, work: call(name, { pid: child.pid, mark }) };
}

describe("whether a carried call still runs", () => {
	// Each case runs on a live shell that carries its mark, so it runs at
	// first and ends only by what the case names (#1981 F75). Its mark is
	// read from /proc, so only where there is one.
	const linux = process.platform === "linux";
	let live: ReturnType<typeof liveCall>;
	// A fresh child's mark reads empty until its exec has laid it out,
	// so each case waits for that; on a loaded builder one read none.
	beforeEach(async () => {
		if (!linux) return;
		live = liveCall("live");
		await execed(live.work.pid, "sleep");
	});
	afterEach(() => {
		if (linux) live.child.kill("SIGKILL");
	});

	it.runIf(linux)("runs while its shell is there with its mark", async () => {
		expect(await callRuns(live.work)).toBe(true);
	});

	it.runIf(linux)(
		"has ended once its end is written, its shell there or not",
		async () => {
			expect(await callRuns(live.work), "before its end").toBe(true);
			writeFileSync(`${live.work.keep}.end`, "0\n");
			expect(await callRuns(live.work)).toBe(false);
		},
	);

	it.runIf(linux)(
		"has ended past its time limit, or a day after it started, so its conversation wakes",
		async () => {
			const now = Date.now();
			const late = { ...live.work, deadline: now + 1 };
			expect(await callRuns(late, now), "before its limit").toBe(true);
			expect(await callRuns(late, now + 1), "at its limit").toBe(false);
			const old = { ...live.work, startedAt: now };
			expect(
				await callRuns(old, now + CALLS_WATCHED_MS - 1),
				"within a day",
			).toBe(true);
			expect(await callRuns(old, now + CALLS_WATCHED_MS), "a day on").toBe(
				false,
			);
		},
	);

	it("has ended once its shell is gone", async () => {
		expect(
			await callRuns(call("gone", { pid: 2 ** 22 + 1 })),
			"no such pid",
		).toBe(false);
	});

	// On a Mac no environment can be read, so the pid alone says.
	it.runIf(linux)("has ended once another process holds its pid", async () => {
		expect(
			await callRuns({ ...live.work, mark: "a-mark-nothing-carries" }),
			"its shell, without the call's mark",
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

	it("reads none where there is no record, and passes over what isn't a call", () => {
		expect(carriedCalls(dir)).toEqual([]);
		writeFileSync(
			join(dir, "carried-calls.json"),
			JSON.stringify([{ kind: "shell" }, call("whole")]),
		);
		expect(carriedCalls(dir).map((work) => work.keep)).toEqual([
			join(dir, "whole"),
		]);
	});

	// A record there that can't be read may name calls: any doubt wakes
	// (#1981 F84), so it throws rather than read as none.
	it("throws for a record cut off, not a list, or unreadable, and adds to none of them", () => {
		const record = join(dir, "carried-calls.json");
		writeFileSync(record, "[{");
		expect(() => carriedCalls(dir), "cut off").toThrow();
		expect(() => keepCarriedCalls(dir, [call("more")])).toThrow();
		expect(readFileSync(record, "utf8"), "left as it was").toBe("[{");
		writeFileSync(record, '{"a":1}');
		expect(() => carriedCalls(dir), "not a list").toThrow();
		rmSync(record);
		mkdirSync(record);
		expect(() => carriedCalls(dir), "a folder").toThrow();
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
			await until("the first write to fail", () => reported.length > 0);
			mkdirSync(folder);
			await until("the wake to be written", () => existsSync(wakeFile));
			expect(JSON.parse(readFileSync(wakeFile, "utf8")).why).toBe(
				"the bash calls its park carried ended",
			);
		} finally {
			stop();
		}
	});

	it("reports a write that keeps failing once, asking for a wake another way once", async () => {
		keepCarriedCalls(dir, [call("ended")]);
		const reported: unknown[] = [];
		let unwritten = 0;
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile: join(dir, "never", "wake"),
			runs: () => false,
			lookEveryMs: LOOK_MS,
			report: (error) => reported.push(error),
			unwritten: () => unwritten++,
		});
		try {
			await quietFor(LOOK_MS, 5);
			expect(reported.length, "reported as it first failed").toBe(1);
			expect(unwritten, "asked another way once").toBe(1);
		} finally {
			stop();
		}
	});

	it("asks again after a wait that doubles each time, up to an hour", async () => {
		keepCarriedCalls(dir, [call("ended")]);
		const wakeFile = join(dir, "wake");
		const again = 1000;
		let clock = 0;
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile,
			runs: () => false,
			lookEveryMs: LOOK_MS,
			wakeAgainMs: again,
			now: () => clock,
			report: () => {},
		});
		// Whether a wake is asked by `at`, taking it as the host would.
		const askedBy = async (at: number): Promise<boolean> => {
			clock = at;
			await quietFor(LOOK_MS, 3);
			const asked = existsSync(wakeFile);
			rmSync(wakeFile, { force: true });
			return asked;
		};
		try {
			expect(await askedBy(0), "at once").toBe(true);
			expect(await askedBy(again - 1), "not before the wait").toBe(false);
			expect(await askedBy(again), "once it passes").toBe(true);
			expect(await askedBy(3 * again - 1), "twice as long next").toBe(false);
			expect(await askedBy(3 * again), "then again").toBe(true);
			expect(CALLS_WAKE_AGAIN_MOST_MS, "at most an hour").toBe(3_600_000);
		} finally {
			stop();
		}
	});

	it("wakes at once for a record it can't read, which may name calls", async () => {
		mkdirSync(join(dir, "carried-calls.json"));
		const ended: number[] = [];
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile: join(dir, "wake"),
			lookEveryMs: LOOK_MS,
			report: () => {},
			ended: (calls) => ended.push(calls),
		});
		try {
			await until("the wake", () => existsSync(join(dir, "wake")));
			expect(ended, "said as none it can name").toEqual([0]);
		} finally {
			stop();
		}
	});

	it("wakes at once for calls it couldn't record, however they run", async () => {
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile: join(dir, "wake"),
			unrecorded: [call("loop")],
			runs: () => true,
			lookEveryMs: LOOK_MS,
			report: () => {},
		});
		try {
			await until("the wake", () => existsSync(join(dir, "wake")));
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

	// Its looks read off the thread, so one can be out as the watch stops.
	it("writes no wake for a look still out as the watch stops", async () => {
		keepCarriedCalls(dir, [call("ended")]);
		let answer: (runs: boolean) => void = () => undefined;
		let looks = 0;
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile: join(dir, "wake"),
			runs: () => {
				looks++;
				return new Promise((resolve) => {
					answer = resolve;
				});
			},
			lookEveryMs: LOOK_MS,
			report: () => {},
		});
		stop();
		answer(false);
		await quietFor(LOOK_MS, 3);

		expect([looks, existsSync(join(dir, "wake"))]).toEqual([1, false]);
	});

	it("starts no look while the last is still out", async () => {
		keepCarriedCalls(dir, [call("slow")]);
		let looks = 0;
		const stop = watchCarriedCalls({
			folder: dir,
			wakeFile: join(dir, "wake"),
			runs: () => {
				looks++;
				// Never answers, as a look stuck on a slow disk.
				return new Promise<boolean>(() => undefined);
			},
			lookEveryMs: LOOK_MS,
			report: () => {},
		});
		try {
			await quietFor(LOOK_MS, 5);
			expect(looks).toBe(1);
		} finally {
			stop();
		}
	});
});
