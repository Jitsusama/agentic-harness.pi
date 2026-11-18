/**
 * What a session records of each background bash call: written private
 * and whole beside the call's files, sparing it from every reaper while
 * its shell runs within its time limit and a day, read back only for
 * its own session when its pi has gone and it can be taken up, and gone
 * with the call's other files or when taken back.
 */

import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CarriedShell } from "../../../../lib/internal/shell/carried.ts";
import {
	carriedCalls,
	makeKept,
	RECORD_SPARED_FOR_MS,
	removeKept,
} from "../../../../lib/internal/shell/kept.ts";
import {
	forgetKeptJob,
	type KeptJob,
	keptJobsOf,
	recordKeptJob,
	strayKeptJobs,
} from "../../../../lib/internal/shell/kept-jobs.ts";

const PRIVATE = 0o600;
const PERMISSIONS = 0o777;

/** A shell that is there: this process, which answers as one would. */
const HERE = process.pid;

/** A pid no process has: past every kernel's highest. */
const GONE = 999_999_999;

/** When the calls started, and a moment soon after. */
const STARTED = 1_000;
const SOON = 2_000;

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A folder of its own, under which the kept folder is made. */
function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "kept-jobs-"));
	made.push(dir);
	return join(dir, "kept");
}

/** What the kept folder holds, nothing staged left beside a record. */
function listed(where: string): string[] {
	return readdirSync(where);
}

/** A call kept in `where`, its shell's pid written, recorded for `session`. */
async function recorded(
	where: string,
	session: string,
	id: string,
	pid: number,
	extra: { owner?: number; deadline?: number } = {},
): Promise<KeptJob> {
	const keep = await makeKept(where);
	writeFileSync(`${keep}.pid`, `${pid}\n`);
	const work: CarriedShell = {
		kind: "shell",
		keep,
		pid,
		mark: `mark-${id}`,
		startedAt: STARTED,
		...(extra.deadline !== undefined ? { deadline: extra.deadline } : {}),
	};
	const job: KeptJob = {
		session,
		id,
		kind: "shell",
		label: `run ${id}`,
		...(extra.owner !== undefined ? { owner: extra.owner } : {}),
		work,
	};
	recordKeptJob(job);
	return job;
}

describe("a recorded job", () => {
	it("is written for its owner alone, beside the call's files", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		expect(
			statSync(`${job.work.keep}.job`).mode & PERMISSIONS,
			"the record is the owner's alone",
		).toBe(PRIVATE);
	});

	it("spares a running call from every reaper, by its group and its mark", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", HERE);
		const found = carriedCalls(where, SOON);
		expect([...found.groups], "its shell's group").toEqual([HERE]);
		expect([...found.marks], "its call's mark").toEqual(["mark-j1"]);
	});

	it.each([
		["once its shell wrote how it ended", {}, HERE, true],
		["once its shell is gone", {}, GONE, false],
		["once its time limit passed", { deadline: SOON - 1 }, HERE, false],
	])("spares nothing %s", async (_case, extra, pid, ended) => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", pid, extra);
		if (ended) writeFileSync(`${job.work.keep}.end`, "0\n");
		const found = carriedCalls(where, SOON);
		expect(found.groups.size + found.marks.size, "nothing left to spare").toBe(
			0,
		);
	});

	it("spares nothing a day after its call started", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", HERE);
		const found = carriedCalls(where, STARTED + RECORD_SPARED_FOR_MS);
		expect(found.groups.size + found.marks.size, "nothing left to spare").toBe(
			0,
		);
	});

	it("is read back for its own session, running or ended", async () => {
		const where = folder();
		const running = await recorded(where, "s1", "j1", 4242);
		const ended = await recorded(where, "s1", "j2", 4343);
		await recorded(where, "s2", "j3", 4444);
		writeFileSync(`${ended.work.keep}.end`, "1\n");
		const found = keptJobsOf("s1", where, (pid) => pid === 4242);
		expect(
			found.map((job) => job.id).sort(),
			"its own, the running and the ended",
		).toEqual([running.id, ended.id]);
	});

	it("is left to the pi that recorded it while that pi runs", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", 4242, { owner: 77 });
		await recorded(where, "s1", "j2", 4242, { owner: 88 });
		const found = keptJobsOf(
			"s1",
			where,
			() => true,
			(pid) => pid === 77,
		);
		expect(
			found.map((job) => job.id),
			"only the one whose pi has gone",
		).toEqual(["j2"]);
		expect(listed(where).length, "the held one's files kept").toBeGreaterThan(
			0,
		);
	});

	it("goes with its call's files when its shell is gone with no status", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", 4242);
		expect(
			keptJobsOf("s1", where, () => false),
			"none to take up",
		).toEqual([]);
		await vi.waitFor(() =>
			expect(listed(where), "its files removed").toEqual([]),
		);
	});

	it("goes when its call's files are removed", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", 4242);
		await removeKept(job.work.keep);
		expect(listed(where)).toEqual([]);
	});

	it("spares nothing once taken back, leaving the call's other files", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		forgetKeptJob(job.work.keep);
		const found = carriedCalls(where, SOON);
		expect(found.groups.size + found.marks.size, "nothing spared").toBe(0);
		expect(listed(where), "its pid still kept").toContain(
			`${job.work.keep.split("/").pop()}.pid`,
		);
	});

	it("is passed over when it isn't one this code wrote", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", 4242);
		writeFileSync(`${job.work.keep}.job`, '{"session":"s1"}');
		expect(keptJobsOf("s1", where, () => true)).toEqual([]);
	});

	it("reads nothing before there is a folder", () => {
		expect(keptJobsOf("s1", folder(), () => true)).toEqual([]);
	});
});

describe("a stray recorded job", () => {
	it("is one whose pi has gone and whose end isn't said", async () => {
		const where = folder();
		await recorded(where, "s1", "held", 4242, { owner: 77 });
		await recorded(where, "s1", "stray", 4242, { owner: 88 });
		const ended = await recorded(where, "s2", "ended", 4242, { owner: 88 });
		writeFileSync(`${ended.work.keep}.end`, "0\n");
		expect(
			strayKeptJobs(where, (pid) => pid === 77).map((job) => job.id),
		).toEqual(["stray"]);
	});
});
