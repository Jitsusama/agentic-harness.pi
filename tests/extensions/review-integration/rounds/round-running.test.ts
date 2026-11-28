/**
 * A Mac starts as many roster rounds at once as its config allows, one
 * unless it says more, so a start reads which rounds still run there,
 * from the leases their reviewers' own supervisors keep. These pin
 * which rounds count: one a live supervisor holds, or one still
 * handing its reviewers out, and never one that finished, an old one,
 * or a judge; and which of the count, a round too young or too little
 * free holds a start beside them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEAST_FREE_FOR_ANOTHER_PERCENT,
	RUNNING_LOOK_BACK_MS,
	type RunningRound,
	rosterRoundsRunning,
	roundsHeld,
	runningSaid,
	SETTLED_AFTER_MS,
} from "../../../../extensions/review-integration/round-running.ts";
import {
	type AskRound,
	newRunId,
} from "../../../../lib/core/review/ask/run.ts";
import {
	HEARTBEAT_STALE_MS,
	type ProcessFacts,
} from "../../../../lib/subagent/index.ts";
import { STARTING_FOR_MS } from "../../../../lib/subagent/lease.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "round-running-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const SUPERVISOR = 4242;
const SUPERVISOR_STARTED = 1_795_724_446_000;

/** A machine where only the supervisor the leases name still runs. */
const SUPERVISOR_LIVES: ProcessFacts = {
	alive: (pid) => pid === SUPERVISOR,
	startedAt: async (pid) =>
		pid === SUPERVISOR ? SUPERVISOR_STARTED : undefined,
};

/** A run's folder name for a round started at `at`, as reviewers leave it. */
function runNamed(kind: AskRound, at: number, serial = 1): string {
	return newRunId(kind, new Date(at), serial);
}

/** A reviewer's folder in `run`, with the lease its supervisor wrote. */
function reviewer(
	run: string,
	id: string,
	lease: Record<string, unknown> | undefined,
): void {
	const dir = join(root, "runs", run, "reviewers", id);
	mkdirSync(dir, { recursive: true });
	if (lease !== undefined) {
		writeFileSync(join(dir, "lease.json"), JSON.stringify(lease));
	}
}

const held = (now: number) => ({
	supervisorPid: SUPERVISOR,
	supervisorStartedAt: SUPERVISOR_STARTED,
	updatedAt: new Date(now).toISOString(),
	state: "running",
});

const done = (now: number) => ({
	...held(now),
	state: "complete",
	completedAt: new Date(now).toISOString(),
});

describe("whether a roster round still runs here", () => {
	it("finds none where no round has left a folder", async () => {
		expect(
			await rosterRoundsRunning(root, SUPERVISOR_LIVES, Date.now()),
		).toEqual([]);
	});

	it("finds a round whose reviewer a live supervisor holds, counting who still runs", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 5 * 60_000);
		reviewer(run, "hawk", held(now));
		reviewer(run, "owl", held(now));
		reviewer(run, "wren", done(now));

		expect(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now)).toEqual([
			{
				runId: run,
				reviewersRunning: 2,
				runningMs: 5 * 60_000,
			},
		]);
	});

	it("lists the machine's processes once a look, however many reviewers it reads", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 5 * 60_000);
		for (const id of ["hawk", "owl", "wren", "kite"]) {
			reviewer(run, id, { ...held(now), supervisorStartTicks: undefined });
		}
		let listings = 0;
		let asked = 0;
		const listed: ProcessFacts = {
			alive: (pid) => pid === SUPERVISOR,
			startedAt: async () => {
				asked += 1;
				return SUPERVISOR_STARTED;
			},
			startTimes: async () => {
				listings += 1;
				return new Map([[SUPERVISOR, SUPERVISOR_STARTED]]);
			},
		};

		const [round] = await rosterRoundsRunning(root, listed, now);

		expect(round?.reviewersRunning, "every reviewer read as running").toBe(4);
		expect(listings, "one listing for the look").toBe(1);
		expect(asked, "no program run per reviewer").toBe(0);
	});

	it("falls back to a lease's heartbeat where it names no start, running while it is fresh", async () => {
		const now = Date.now();
		const fresh = runNamed("council", now - 5 * 60_000, 1);
		const { supervisorStartedAt: _, ...unnamed } = held(now);
		reviewer(fresh, "hawk", unnamed);

		expect(
			(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now))[0]?.runId,
		).toBe(fresh);
	});

	it("falls back to a lease's heartbeat where it names no start, gone once it is stale", async () => {
		const now = Date.now();
		const stale = runNamed("council", now - 5 * 60_000, 1);
		const { supervisorStartedAt: _, ...unnamed } = held(
			now - HEARTBEAT_STALE_MS - 1_000,
		);
		reviewer(stale, "hawk", unnamed);

		expect(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now)).toEqual([]);
	});

	it("stops counting a round that never handed out a reviewer once it is old", async () => {
		const now = Date.now();
		const run = runNamed("council", now - STARTING_FOR_MS - 60_000);
		mkdirSync(join(root, "runs", run), { recursive: true });

		expect(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now)).toEqual([]);
	});

	it("finds none once every reviewer's lease says it completed", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 5 * 60_000);
		reviewer(run, "hawk", done(now));
		reviewer(run, "owl", done(now));

		expect(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now)).toEqual([]);
	});

	it("finds none whose supervisor is gone, though its lease never closed", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 5 * 60_000);
		reviewer(run, "hawk", { ...held(now), supervisorPid: SUPERVISOR + 1 });

		expect(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now)).toEqual([]);
	});

	// A supervisor alive past its own wall, as a wedged one is, would
	// otherwise hold every Mac round behind it for as long as it lived.
	it("leaves out a round started before the look back, though a live supervisor holds it, and a judge's", async () => {
		const now = Date.now();
		reviewer(
			runNamed("council", now - RUNNING_LOOK_BACK_MS - 60_000),
			"hawk",
			held(now),
		);
		reviewer(runNamed("judge", now - 60_000), "judge", held(now));

		expect(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now)).toEqual([]);
	});

	it("leaves out a newer round that finished, past which an older one still runs", async () => {
		const now = Date.now();
		const older = runNamed("stack", now - 20 * 60_000, 1);
		const newer = runNamed("council", now - 2 * 60_000, 2);
		reviewer(older, "hawk", held(now));
		reviewer(newer, "hawk", done(now));

		const running = await rosterRoundsRunning(root, SUPERVISOR_LIVES, now);

		expect(running.map((round) => round.runId)).toEqual([older]);
	});

	// A Mac that may run two at once has to count them, not stop at one.
	it("counts every round that still runs, newest first", async () => {
		const now = Date.now();
		const older = runNamed("stack", now - 20 * 60_000, 1);
		const newer = runNamed("council", now - 4 * 60_000, 2);
		reviewer(older, "hawk", held(now));
		reviewer(newer, "hawk", held(now));
		reviewer(newer, "owl", held(now));

		expect(await rosterRoundsRunning(root, SUPERVISOR_LIVES, now)).toEqual([
			{ runId: newer, reviewersRunning: 2, runningMs: 4 * 60_000 },
			{ runId: older, reviewersRunning: 1, runningMs: 20 * 60_000 },
		]);
	});

	it("counts a young round still handing out its reviewers", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 10_000);
		mkdirSync(join(root, "runs", run, "reviewers"), { recursive: true });

		const [round, ...others] = await rosterRoundsRunning(
			root,
			SUPERVISOR_LIVES,
			now,
		);

		expect(others).toEqual([]);
		expect(round).toEqual({
			runId: run,
			reviewersRunning: 0,
			runningMs: 10_000,
		});
		expect(round === undefined ? "" : runningSaid(round)).toContain(
			"its reviewers are still being handed out",
		);
	});
});

describe("what a start waiting on a running round says", () => {
	it("names the round and how many of its reviewers still run", () => {
		expect(runningSaid({ runId: "council-x", reviewersRunning: 3 })).toBe(
			"council-x still runs on this Mac (3 of its reviewers are still running), and a Mac starts one roster round at a time",
		);
		expect(runningSaid({ runId: "council-x", reviewersRunning: 1 })).toContain(
			"1 of its reviewers is still running",
		);
	});

	it("says how long the round has run, so a wedged one shows as one", () => {
		expect(
			runningSaid({
				runId: "council-x",
				reviewersRunning: 2,
				runningMs: 95 * 60_000 + 30_000,
			}),
		).toContain("2 of its reviewers are still running, 95 minutes in");
	});
});

/** A round `minutes` in, two of its reviewers still running. */
function runningFor(minutes: number, runId = "council-x"): RunningRound {
	return { runId, reviewersRunning: 2, runningMs: minutes * 60_000 };
}

/** A free reading of `percent`, counting how often it was asked. */
function reads(percent: number | undefined) {
	const read = {
		asked: 0,
		free: async () => {
			read.asked += 1;
			return percent;
		},
	};
	return read;
}

// 1OGSE7 (ccebba79): a round takes 3 to 4 GB, the work Mac reads 95%
// free, and a line of 70 rounds one at a time ends near 10:05.
describe("whether a Mac starts a round beside those running", () => {
	it("starts with none running, reading no free memory, as the Mac's own bar judges it", async () => {
		const read = reads(10);

		expect(await roundsHeld([], 1, read.free)).toBeUndefined();
		expect(read.asked).toBe(0);
	});

	it("holds at one at a time while one runs, saying so as it always has", async () => {
		const read = reads(95);
		const round = runningFor(30);

		expect(await roundsHeld([round], 1, read.free)).toEqual({
			by: "count",
			said: runningSaid(round),
		});
		expect(read.asked, "a count reached needs no reading").toBe(0);
	});

	it("starts a second at two at once beside one 5 minutes in, with 70% free", async () => {
		expect(
			await roundsHeld([runningFor(5)], 2, reads(70).free),
		).toBeUndefined();
	});

	it("holds a second at two at once while two run, naming both", async () => {
		const held = await roundsHeld(
			[runningFor(10, "council-b"), runningFor(40, "council-a")],
			2,
			reads(95).free,
		);

		expect(held?.by).toBe("count");
		expect(held?.said).toBe(
			"2 roster rounds still run on this Mac (council-b, council-a), and it starts at most 2 at a time",
		);
	});

	// 26 November: a start beside a round whose reviewers had yet to load
	// read memory they were about to take.
	it("holds a second beside a round only 1 minute in, before its reviewers load", async () => {
		const read = reads(95);
		const held = await roundsHeld([runningFor(1)], 2, read.free);

		expect(held?.by).toBe("young");
		expect(held?.said).toContain("council-x has run 1 minutes");
		expect(held?.said).toContain("3 minutes in");
		expect(read.asked, "a young round's reading would leave it out").toBe(0);
	});

	it("holds a second until every round running is 3 minutes in, not just the oldest", async () => {
		const held = await roundsHeld(
			[runningFor(2, "council-b"), runningFor(40, "council-a")],
			3,
			reads(95).free,
		);

		expect(held?.by).toBe("young");
		expect(held?.said).toContain("council-b");
		expect(SETTLED_AFTER_MS).toBe(3 * 60_000);
	});

	it("holds a second with 50% free, under the bar for another", async () => {
		const held = await roundsHeld([runningFor(5)], 2, reads(50).free);

		expect(held).toEqual({
			by: "free",
			said: "this Mac reads 50% free, and another round starts beside 1 running only at 60% free or more",
		});
		expect(LEAST_FREE_FOR_ANOTHER_PERCENT).toBe(60);
	});

	it("starts a second at exactly 60% free", async () => {
		expect(
			await roundsHeld([runningFor(5)], 2, reads(60).free),
		).toBeUndefined();
	});

	it("holds a second while the free memory can't be read", async () => {
		const held = await roundsHeld([runningFor(5)], 2, reads(undefined).free);

		expect(held?.by).toBe("free");
		expect(held?.said).toContain("can't be read");
	});
});
