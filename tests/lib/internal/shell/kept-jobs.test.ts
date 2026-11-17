/**
 * What a session records of each background bash call: written private
 * beside the call's files, sparing it from every reaper until its shell
 * writes how it ended, read back only for its own session when it can
 * be taken up, and gone with the call's other files.
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
import { afterEach, describe, expect, it } from "vitest";
import type { CarriedShell } from "../../../../lib/internal/shell/carried.ts";
import {
	carriedCalls,
	makeKept,
	removeKept,
} from "../../../../lib/internal/shell/kept.ts";
import {
	type KeptJob,
	keptJobsOf,
	recordKeptJob,
} from "../../../../lib/internal/shell/kept-jobs.ts";

const PRIVATE = 0o600;
const PERMISSIONS = 0o777;

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

/** A call kept in `where`, its shell's pid written, recorded for `session`. */
function recorded(
	where: string,
	session: string,
	id: string,
	pid: number,
): KeptJob {
	const keep = makeKept(where);
	writeFileSync(`${keep}.pid`, `${pid}\n`);
	const work: CarriedShell = {
		kind: "shell",
		keep,
		pid,
		mark: `mark-${id}`,
		startedAt: 1,
	};
	const job: KeptJob = { session, id, kind: "shell", label: `run ${id}`, work };
	recordKeptJob(job);
	return job;
}

describe("a recorded job", () => {
	it("is written for its owner alone, beside the call's files", () => {
		const where = folder();
		const job = recorded(where, "s1", "j1", 4242);
		expect(
			statSync(`${job.work.keep}.job`).mode & PERMISSIONS,
			"the record is the owner's alone",
		).toBe(PRIVATE);
	});

	it("spares a running call from every reaper, by its group and its mark", () => {
		const where = folder();
		recorded(where, "s1", "j1", 4242);
		const found = carriedCalls(where);
		expect([...found.groups], "its shell's group").toEqual([4242]);
		expect([...found.marks], "its call's mark").toEqual(["mark-j1"]);
	});

	it("spares nothing once its shell wrote how it ended", () => {
		const where = folder();
		const job = recorded(where, "s1", "j1", 4242);
		writeFileSync(`${job.work.keep}.end`, "0\n");
		const found = carriedCalls(where);
		expect(found.groups.size + found.marks.size, "nothing left to spare").toBe(
			0,
		);
	});

	it("is read back for its own session, running or ended", () => {
		const where = folder();
		const running = recorded(where, "s1", "j1", 4242);
		const ended = recorded(where, "s1", "j2", 4343);
		recorded(where, "s2", "j3", 4444);
		writeFileSync(`${ended.work.keep}.end`, "1\n");
		const found = keptJobsOf("s1", where, (pid) => pid === 4242);
		expect(
			found.map((job) => job.id).sort(),
			"its own, the running and the ended",
		).toEqual([running.id, ended.id]);
	});

	it("goes with its call's files when its shell is gone with no status", () => {
		const where = folder();
		recorded(where, "s1", "j1", 4242);
		expect(keptJobsOf("s1", where, () => false), "none to take up").toEqual(
			[],
		);
		expect(readdirSync(where), "its files removed").toEqual([]);
	});

	it("goes when its call's files are removed", () => {
		const where = folder();
		const job = recorded(where, "s1", "j1", 4242);
		removeKept(job.work.keep);
		expect(readdirSync(where)).toEqual([]);
	});

	it("is passed over when it isn't one this code wrote", () => {
		const where = folder();
		const job = recorded(where, "s1", "j1", 4242);
		writeFileSync(`${job.work.keep}.job`, '{"session":"s1"}');
		expect(keptJobsOf("s1", where, () => true)).toEqual([]);
	});

	it("reads nothing before there is a folder", () => {
		expect(keptJobsOf("s1", folder(), () => true)).toEqual([]);
	});
});
