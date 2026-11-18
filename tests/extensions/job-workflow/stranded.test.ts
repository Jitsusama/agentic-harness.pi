/**
 * A carried call a session took up, whose end was never said, is said on
 * the session's return. After the 22:11 host restart on 14 November
 * carried 0G4FXL's j83 to j88, the 22:22 reboot killed the host that had
 * taken them up; only j87 was said lost, and the rest were never said,
 * their marks left for the week's sweep (OSPHT4 [7a4f0901]).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobs } from "../../../extensions/job-workflow/jobs.ts";
import {
	CARRIED_ENTRY,
	type Carried,
	strandedIn,
	TAKEN_ENTRY,
	takeUp,
} from "../../../extensions/job-workflow/moved.ts";
import type { JobResult } from "../../../extensions/job-workflow/outbox.ts";
import {
	type CarriedShell,
	watchCarried,
} from "../../../lib/internal/shell/carried.ts";
import { makeKept, markCarried } from "../../../lib/internal/shell/kept.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";

const made: string[] = [];
const running: { kill(): boolean }[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
	for (const child of running.splice(0)) child.kill();
});

/** A carried call's work, its files made fresh and marked carried. */
async function shellWork(pid = 4242, mark = "mark-1"): Promise<CarriedShell> {
	const dir = mkdtempSync(join(tmpdir(), "stranded-"));
	made.push(dir);
	const keep = await makeKept(dir);
	markCarried(keep, mark);
	return { kind: "shell", keep, pid, mark, startedAt: 1000 };
}

const entry = (customType: string, data: unknown) => ({
	type: "custom",
	customType,
	data,
});

const carriedAt = (at: number, ...works: CarriedShell[]): Carried => ({
	at,
	jobs: works.map((work, index) => ({
		id: `j${index + 3}`,
		kind: "shell",
		label: `sleep ${index}`,
		work,
	})),
	results: [],
});

/** A pid nothing runs as now: a process that has ended. */
function endedPid(): number {
	const ran = spawnSync("true");
	expect(ran.pid, "the process ran").toBeGreaterThan(0);
	return ran.pid;
}

describe("a carried call taken up and never said", () => {
	it("is found once its shell is gone and its mark still stands", async () => {
		const work = await shellWork();
		const carried = carriedAt(5000, work);
		const found = strandedIn(
			[entry(CARRIED_ENTRY, carried), entry(TAKEN_ENTRY, { at: 5000 })],
			() => true,
		);
		expect(found?.jobs, "the call that was never said").toEqual(carried.jobs);
		expect(found?.results, "results were said as it was taken up").toEqual([]);
	});

	it("is not found while none is gone, or before anything took it up", async () => {
		const branch = [
			entry(CARRIED_ENTRY, carriedAt(5000, await shellWork())),
			entry(TAKEN_ENTRY, { at: 5000 }),
		];
		expect(
			strandedIn(branch, () => false),
			"none gone",
		).toBeUndefined();
		expect(
			strandedIn(
				[entry(CARRIED_ENTRY, carriedAt(9000, await shellWork()))],
				() => true,
			),
			"not taken up yet: carriedIn's to take",
		).toBeUndefined();
	});

	it("is found once, though two moves carried it", async () => {
		const work = await shellWork();
		const found = strandedIn(
			[
				entry(CARRIED_ENTRY, carriedAt(5000, work)),
				entry(TAKEN_ENTRY, { at: 5000 }),
				entry(CARRIED_ENTRY, carriedAt(7000, work)),
				entry(TAKEN_ENTRY, { at: 7000 }),
			],
			() => true,
		);
		expect(found?.jobs.map((job) => job.work)).toEqual([work]);
	});

	it("is left to a newer move not yet taken up that carries it again", async () => {
		// A second host restart carried it on; carriedIn takes that one up.
		const work = await shellWork();
		expect(
			strandedIn(
				[
					entry(CARRIED_ENTRY, carriedAt(5000, work)),
					entry(TAKEN_ENTRY, { at: 5000 }),
					entry(CARRIED_ENTRY, carriedAt(7000, work)),
				],
				() => true,
			),
		).toBeUndefined();
	});

	it("reads its mark and its shell from the machine", async () => {
		const gone = await shellWork(endedPid());
		const said = await shellWork(endedPid());
		rmSync(`${said.keep}.carried`);
		const shell = spawn("sleep", ["30"], {
			env: { ...process.env, [CALL_VARIABLE]: "mark-running" },
		});
		running.push(shell);
		const live = await shellWork(shell.pid, "mark-running");
		// A pid now another process's, as after a reboot, isn't the call.
		const reused = await shellWork(process.pid, "mark-reused");
		const found = strandedIn([
			entry(CARRIED_ENTRY, carriedAt(5000, gone, said, live, reused)),
			entry(TAKEN_ENTRY, { at: 5000 }),
		]);
		expect(found?.jobs.map((job) => job.work.keep).sort()).toEqual(
			[gone.keep, reused.keep].sort(),
		);
	});

	it("is said on return as exited or lost, with its output, and its files go", async () => {
		const exited = await shellWork();
		writeFileSync(`${exited.keep}.out`, "done\n");
		writeFileSync(`${exited.keep}.end`, "0\n");
		const lost = await shellWork();
		writeFileSync(`${lost.keep}.out`, "half\n");
		const said: JobResult[] = [];
		const jobs = createJobs(
			(result) => said.push(result),
			() => {},
		);
		takeUp(carriedAt(5000, exited, lost), {
			jobs,
			outbox: { post: (result) => said.push(result) },
			session: "s1",
			append: () => {},
			now: () => 46_000,
			watch: (work, signal) =>
				watchCarried(work, signal, { alive: () => false }),
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(said.map((result) => result.text)).toEqual([
			"`sleep 0` exited 0 after 45 seconds.\ndone",
			"Failed. `sleep 1` was lost after 45 seconds: its shell is gone and wrote no exit status.\nhalf",
		]);
		jobs.delivered(() => false);
		// Removed off the loop, so just after.
		await vi.waitFor(() => {
			for (const work of [exited, lost])
				expect(
					existsSync(`${work.keep}.carried`),
					"its files go once said",
				).toBe(false);
		});
	});
});
