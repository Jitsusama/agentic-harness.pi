/**
 * A session's jobs carried through a move: a pi going to a host hands on
 * what can be carried and keeps what holds, its log naming what went;
 * the host takes each up under its id, says its end in today's words, a
 * lost call with its last lines, and removes its files once said.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createJobs,
	type Jobs,
} from "../../../extensions/job-workflow/jobs.ts";
import {
	CARRIED_ENTRY,
	type Carried,
	carriedIn,
	carryAway,
	movingOn,
	TAKEN_ENTRY,
	takeUp,
} from "../../../extensions/job-workflow/moved.ts";
import type { JobResult } from "../../../extensions/job-workflow/outbox.ts";
import type {
	CarriedEnd,
	CarriedShell,
} from "../../../lib/internal/shell/carried.ts";
import { makeKept } from "../../../lib/internal/shell/kept.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A registry whose said results land in `said`. */
function registry(): { jobs: Jobs; said: JobResult[] } {
	const said: JobResult[] = [];
	return {
		said,
		jobs: createJobs(
			(result) => said.push(result),
			() => {},
		),
	};
}

/** A carried call's work, its files made fresh. */
function shellWork(): CarriedShell {
	const dir = mkdtempSync(join(tmpdir(), "moved-"));
	made.push(dir);
	return {
		kind: "shell",
		keep: makeKept(dir),
		pid: 4242,
		mark: "mark-1",
		startedAt: 1000,
	};
}

/** A watch the test ends by hand, with how the call ended. */
function handWatch() {
	let end: (how: CarriedEnd) => void = () => {};
	const ended = new Promise<CarriedEnd>((resolve) => {
		end = resolve;
	});
	const handed: string[] = [];
	return {
		end,
		handed,
		watch: (work: CarriedShell) => ({
			ended,
			handed: () => handed.push(work.keep),
		}),
	};
}

/** Let a watch's end be heard. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("a pi that is ending", () => {
	const note = (to: string, pid: number) => () => ({ to, pid });

	it("is moving on when its note names this process and where it goes", () => {
		expect(movingOn("s1", note("attended", 7), 7), "to attended").toBe(true);
		expect(movingOn("s1", note("background", 7), 7), "to background").toBe(
			true,
		);
		expect(movingOn("s1", note("pi", 7), 7), "released to plain pi").toBe(true);
	});

	it("is not when the note is another process's, names nowhere it knows, or is missing", () => {
		expect(movingOn("s1", note("attended", 8), 7), "another pid").toBe(false);
		expect(movingOn("s1", note("mars", 7), 7), "nowhere known").toBe(false);
		expect(
			movingOn("s1", () => undefined, 7),
			"no note",
		).toBe(false);
		expect(movingOn(undefined, note("attended", 7), 7), "no session").toBe(
			false,
		);
	});
});

describe("carrying away", () => {
	it("hands on what can be carried, unstopped, and leaves what holds", () => {
		const { jobs } = registry();
		const work = shellWork();
		const handed: string[] = [];
		const command = jobs.start({
			kind: "shell",
			label: "sleep 45",
			toolCallId: "call-1",
			carry: { what: () => work, handed: () => handed.push("j1") },
		});
		jobs.start({ kind: "subagent", label: "a fleet" });
		const written: [string, Carried][] = [];
		const carried = carryAway(
			jobs,
			{ waiting: () => [] },
			(type, data) => written.push([type, data]),
			5000,
		);
		expect(carried?.jobs).toEqual([
			{
				id: "j1",
				kind: "shell",
				label: "sleep 45",
				toolCallId: "call-1",
				work,
			},
		]);
		expect(written, "its log names what went").toEqual([
			[CARRIED_ENTRY, carried],
		]);
		expect(handed, "the call was told to let go").toEqual(["j1"]);
		expect(command.signal.aborted, "the call was not stopped").toBe(false);
		expect(jobs.holds(), "the fleet still holds").toEqual([
			{ id: "j2", kind: "subagent", label: "a fleet" },
		]);
	});

	it("holds a host's restart on the work it can't keep, though a move would carry it", () => {
		const { jobs } = registry();
		jobs.start({
			kind: "shell",
			label: "sleep 45",
			carry: { what: () => shellWork(), handed: () => {} },
		});
		jobs.start({
			kind: "review-checks",
			label: "checks",
			carry: { what: () => ({ kind: "review-checks" }), handed: () => {} },
		});
		jobs.start({ kind: "subagent", label: "a fleet" });

		expect(
			jobs.holds((work) => work.kind === "shell").map(({ id }) => id),
			"the checks and the fleet",
		).toEqual(["j2", "j3"]);
		expect(
			jobs.holds().map(({ id }) => id),
			"a move: the fleet",
		).toEqual(["j3"]);
	});

	it("writes nothing when there is nothing to carry", () => {
		const { jobs } = registry();
		const written: unknown[] = [];
		expect(
			carryAway(
				jobs,
				{ waiting: () => [] },
				(...entry) => written.push(entry),
				1,
			),
		).toBeUndefined();
		expect(written).toEqual([]);
	});
});

describe("what a log says was carried", () => {
	const carried: Carried = { at: 5000, jobs: [], results: [] };
	const entry = (customType: string, data: unknown) => ({
		type: "custom",
		customType,
		data,
	});

	it("is found until something takes it up", () => {
		expect(carriedIn([entry(CARRIED_ENTRY, carried)])).toEqual(carried);
		expect(
			carriedIn([
				entry(CARRIED_ENTRY, carried),
				entry(TAKEN_ENTRY, { at: 5000 }),
			]),
			"taken already",
		).toBeUndefined();
	});

	it("is the latest move's, not an older one taken before", () => {
		const later = { ...carried, at: 9000 };
		expect(
			carriedIn([
				entry(CARRIED_ENTRY, carried),
				entry(TAKEN_ENTRY, { at: 5000 }),
				entry(CARRIED_ENTRY, later),
			]),
		).toEqual(later);
	});
});

describe("taking up", () => {
	/** Take up one carried call `j3`, with a result `j2` not yet said. */
	function tookUp() {
		const { jobs, said } = registry();
		const work = shellWork();
		const watch = handWatch();
		const appended: [string, unknown][] = [];
		takeUp(
			{
				at: 5000,
				jobs: [{ id: "j3", kind: "shell", label: "sleep 45", work }],
				results: [
					{ jobId: "j2", label: "echo hi", text: "`echo hi` exited 0." },
				],
			},
			{
				jobs,
				outbox: { post: (result) => said.push(result) },
				session: "s1",
				append: (type, data) => appended.push([type, data]),
				now: () => 46_000,
				watch: watch.watch,
			},
		);
		return { jobs, said, work, watch, appended };
	}

	it("says what was waiting, keeps each call's id and marks the move taken", () => {
		const { jobs, said, appended } = tookUp();
		expect(said.map((result) => result.jobId)).toEqual(["j2"]);
		expect(jobs.list().map((job) => [job.id, job.state])).toEqual([
			["j3", "running"],
		]);
		expect(
			jobs.start({ kind: "shell", label: "next" }).id,
			"ids carry on",
		).toBe("j4");
		expect(appended).toEqual([[TAKEN_ENTRY, { at: 5000 }]]);
	});

	it("says a call's end as its own pi would have, then removes its files", async () => {
		const { jobs, said, work, watch } = tookUp();
		watch.end({ how: "exited", code: 0, output: "carried-job-ended\n" });
		await settled();
		expect(said.at(-1)).toEqual({
			jobId: "j3",
			label: "sleep 45",
			text: "`sleep 45` exited 0 after 45 seconds.\ncarried-job-ended",
		});
		expect(existsSync(`${work.keep}.out`), "kept until said").toBe(true);
		jobs.delivered(() => false);
		expect(existsSync(`${work.keep}.out`), "gone once said").toBe(false);
	});

	it("says a call whose shell is gone as lost, with its last lines", async () => {
		const { said, watch } = tookUp();
		watch.end({ how: "lost", output: "one\ntwo\n" });
		await settled();
		expect(said.at(-1)?.text).toBe(
			"Failed. `sleep 45` was lost after 45 seconds: its shell is gone and wrote no exit status.\none\ntwo",
		);
	});

	it("can carry a call on again while it runs", () => {
		const { jobs, watch, work } = tookUp();
		expect(jobs.carryOut().map((job) => job.work)).toEqual([work]);
		expect(watch.handed, "the watch let go").toEqual([work.keep]);
	});

	it("says a kind it can't take up, rather than dropping it", () => {
		const { jobs, said } = registry();
		takeUp(
			{
				at: 1,
				jobs: [
					{ id: "j1", kind: "review", label: "CI", work: { kind: "review" } },
				],
				results: [],
			},
			{
				jobs,
				outbox: { post: () => {} },
				session: "s1",
				append: () => {},
			},
		);
		expect(said.at(-1)?.text).toMatch(/can't take up a review job/);
	});

	it("hands another kind to whoever answers for it, under its id, carried on again", () => {
		const { jobs, said } = registry();
		const offered: unknown[] = [];
		const started: string[] = [];
		const again = { kind: "review-checks", again: true };
		takeUp(
			{
				at: 1,
				jobs: [
					{
						id: "j4",
						kind: "review",
						label: "checks on shop/app#7",
						work: { kind: "review-checks" },
					},
				],
				results: [],
			},
			{
				jobs,
				outbox: { post: () => {} },
				session: "s1",
				append: () => {},
				offer: (work) => {
					offered.push(work);
					return {
						carry: { what: () => again, handed: () => {} },
						start: (job) => started.push(job.id),
					};
				},
			},
		);
		expect(offered).toEqual([{ kind: "review-checks" }]);
		expect(started, "started under the id it had").toEqual(["j4"]);
		expect(said, "nothing said while it runs").toEqual([]);
		expect(jobs.carryOut().map((job) => [job.id, job.work])).toEqual([
			["j4", again],
		]);
	});
});
