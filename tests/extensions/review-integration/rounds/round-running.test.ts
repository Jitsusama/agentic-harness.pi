/**
 * A Mac starts one roster round at a time, so a start reads whether
 * another round still runs there, from the leases its reviewers' own
 * supervisors keep. These pin which rounds count: one a live
 * supervisor holds, or one still handing its reviewers out, and never
 * one that finished, an old one, or a judge.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RUNNING_LOOK_BACK_MS,
	rosterRoundRunning,
	runningSaid,
} from "../../../../extensions/review-integration/round-running.ts";
import type { ProcessFacts } from "../../../../lib/subagent/index.ts";

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
function runNamed(kind: string, at: number, serial = 1): string {
	const stamp = new Date(at)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(".", "")
		.replace("Z", "");
	return `${kind}-${stamp}-${String(serial).padStart(6, "0")}`;
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
			await rosterRoundRunning(root, SUPERVISOR_LIVES, Date.now()),
		).toBeUndefined();
	});

	it("finds a round whose reviewer a live supervisor holds, counting who still runs", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 5 * 60_000);
		reviewer(run, "hawk", held(now));
		reviewer(run, "owl", held(now));
		reviewer(run, "wren", done(now));

		expect(await rosterRoundRunning(root, SUPERVISOR_LIVES, now)).toEqual({
			runId: run,
			reviewersRunning: 2,
		});
	});

	it("finds none once every reviewer's lease says it completed", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 5 * 60_000);
		reviewer(run, "hawk", done(now));
		reviewer(run, "owl", done(now));

		expect(
			await rosterRoundRunning(root, SUPERVISOR_LIVES, now),
		).toBeUndefined();
	});

	it("finds none whose supervisor is gone, though its lease never closed", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 5 * 60_000);
		reviewer(run, "hawk", { ...held(now), supervisorPid: SUPERVISOR + 1 });

		expect(
			await rosterRoundRunning(root, SUPERVISOR_LIVES, now),
		).toBeUndefined();
	});

	it("leaves out a round started before the look back and a judge's", async () => {
		const now = Date.now();
		reviewer(
			runNamed("council", now - RUNNING_LOOK_BACK_MS - 60_000),
			"hawk",
			held(now),
		);
		reviewer(runNamed("judge", now - 60_000), "judge", held(now));

		expect(
			await rosterRoundRunning(root, SUPERVISOR_LIVES, now),
		).toBeUndefined();
	});

	it("names the newest round that still runs, past a newer one that finished", async () => {
		const now = Date.now();
		const older = runNamed("stack", now - 20 * 60_000, 1);
		const newer = runNamed("council", now - 2 * 60_000, 2);
		reviewer(older, "hawk", held(now));
		reviewer(newer, "hawk", done(now));

		expect((await rosterRoundRunning(root, SUPERVISOR_LIVES, now))?.runId).toBe(
			older,
		);
	});

	it("counts a young round still handing out its reviewers", async () => {
		const now = Date.now();
		const run = runNamed("council", now - 10_000);
		mkdirSync(join(root, "runs", run, "reviewers"), { recursive: true });

		const round = await rosterRoundRunning(root, SUPERVISOR_LIVES, now);

		expect(round).toEqual({ runId: run, reviewersRunning: 0 });
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
});
