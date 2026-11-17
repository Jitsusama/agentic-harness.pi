/**
 * Each running bash job recorded once under its session and its pi,
 * asked again for a minute while its call has nothing to record yet,
 * recorded again under a session it rolls over to, and taken back at a
 * close for good; taken up again as a carry of what the session doesn't
 * already hold; and a cut-off notice that calls no job dead the session
 * took up again. Every running job, of any kind, is noted by session,
 * moved with a rollover and taken back as nothing runs or at a close.
 */

import { describe, expect, it } from "vitest";
import { leftDead } from "../../../extensions/job-workflow/cut-off.ts";
import type { JobEntry } from "../../../extensions/job-workflow/jobs.ts";
import {
	RECORD_FOR_MS,
	recordedCarry,
	recordJobs,
} from "../../../extensions/job-workflow/recorded.ts";
import type { RunningNote } from "../../../extensions/job-workflow/running.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import type { KeptJob } from "../../../lib/internal/shell/kept-jobs.ts";
import type { CarriedWork } from "../../../lib/jobs/host.ts";

function shell(mark: string): CarriedShell {
	return {
		kind: "shell",
		keep: `/kept/${mark}`,
		pid: 4242,
		mark,
		startedAt: 1,
	};
}

/** A running job whose carry answers what `work()` gives. */
function job(
	id: string,
	work: () => CarriedWork | undefined,
	kind = "bash",
): JobEntry {
	return {
		id,
		state: "running",
		spec: {
			kind,
			label: `run ${id}`,
			toolCallId: `call-${id}`,
			carry: {
				what: work,
				handed: () => {},
			},
		},
	};
}

/** The pi the recorder says holds the jobs. */
const OWNER = 77;

/**
 * A recorder over `entries` writing into `written` and taking back into
 * `forgotten`, for the session `at.session`, its asks run by hand and
 * its clock at `at.now`.
 */
function recorder(
	entries: JobEntry[],
	written: KeptJob[],
	at: { session: string; now: number } = { session: "s1", now: 0 },
	forgotten: string[] = [],
	notes: Map<string, RunningNote> = new Map(),
) {
	const again: (() => void)[] = [];
	const recording = recordJobs(
		() => ({ list: () => entries }),
		() => at.session,
		{
			write: (kept) => written.push(kept),
			forget: (keep) => forgotten.push(keep),
			later: (_ms, run) => {
				again.push(run);
				return () => {
					again.splice(again.indexOf(run), 1);
				};
			},
			now: () => at.now,
			owner: OWNER,
			note: (session, note) => notes.set(session, note),
			unnote: (session) => notes.delete(session),
		},
	);
	return { recording, again };
}

describe("recording a session's jobs", () => {
	it("writes each running bash job once, under its session", () => {
		const written: KeptJob[] = [];
		const { recording } = recorder([job("j1", () => shell("m1"))], written);
		recording.changed();
		recording.changed();
		expect(written).toEqual([
			{
				session: "s1",
				id: "j1",
				kind: "bash",
				label: "run j1",
				toolCallId: "call-j1",
				owner: OWNER,
				work: shell("m1"),
			},
		]);
	});

	it("records a job again under the session it rolled over to", () => {
		const written: KeptJob[] = [];
		const at = { session: "s1", now: 0 };
		const { recording } = recorder([job("j1", () => shell("m1"))], written, at);
		recording.changed();
		at.session = "s2";
		recording.changed();
		expect(written.map((kept) => kept.session)).toEqual(["s1", "s2"]);
	});

	it("asks a call with nothing to record yet again, until it has", () => {
		let work: CarriedShell | undefined;
		const written: KeptJob[] = [];
		const { recording, again } = recorder([job("j1", () => work)], written);
		recording.changed();
		expect(written, "nothing yet").toEqual([]);
		expect(again, "asked again later").toHaveLength(1);
		work = shell("m1");
		again[0]?.();
		expect(
			written.map((kept) => kept.id),
			"recorded once it could be",
		).toEqual(["j1"]);
	});

	it("stops asking a call with nothing to record a minute on, however often changed", () => {
		const written: KeptJob[] = [];
		const at = { session: "s1", now: 0 };
		const { recording, again } = recorder(
			[job("j1", () => undefined)],
			written,
			at,
		);
		for (let change = 0; change < 100; change += 1) recording.changed();
		expect(again, "still asking within the minute").toHaveLength(1);
		at.now = RECORD_FOR_MS;
		again.shift()?.();
		expect(again, "no more asks past it").toEqual([]);
	});

	it("never records work of another kind, nor asks again for it", () => {
		const written: KeptJob[] = [];
		const { recording, again } = recorder(
			[job("j1", () => ({ kind: "subagent", id: "x" }), "subagent")],
			written,
		);
		recording.changed();
		expect(written).toEqual([]);
		expect(again).toEqual([]);
	});

	it("cancels its pending ask once stopped, and records on a later change", () => {
		let work: CarriedShell | undefined;
		const written: KeptJob[] = [];
		const { recording, again } = recorder([job("j1", () => work)], written);
		recording.changed();
		recording.stop();
		expect(again, "nothing pending").toEqual([]);
		work = shell("m1");
		recording.changed();
		expect(written.map((kept) => kept.id)).toEqual(["j1"]);
	});

	it("takes back what it recorded at a close for good, and records no more", () => {
		const written: KeptJob[] = [];
		const forgotten: string[] = [];
		const { recording } = recorder(
			[job("j1", () => shell("m1"))],
			written,
			{ session: "s1", now: 0 },
			forgotten,
		);
		recording.changed();
		recording.forget();
		recording.changed();
		expect(forgotten, "its record taken back").toEqual(["/kept/m1"]);
		expect(written, "written once, before the close").toHaveLength(1);
	});
});

describe("noting a session's running jobs", () => {
	it("notes every running job, of any kind, under its pi", () => {
		const notes = new Map<string, RunningNote>();
		const entries = [
			job("j1", () => shell("m1")),
			job("j2", () => undefined, "fleet"),
		];
		const { recording } = recorder(entries, [], undefined, [], notes);
		recording.changed();
		expect(notes.get("s1"), "both jobs, under this pi").toEqual({
			owner: OWNER,
			jobs: [
				{ id: "j1", label: "run j1" },
				{ id: "j2", label: "run j2" },
			],
		});
	});

	it("leaves the note its last pi left, and takes its own back once nothing runs", () => {
		const notes = new Map<string, RunningNote>([
			["s1", { owner: 1, jobs: [{ id: "j9", label: "left" }] }],
		]);
		const entries: JobEntry[] = [];
		const { recording } = recorder(entries, [], undefined, [], notes);
		recording.changed();
		expect(notes.has("s1"), "a note its last pi left waits to be read").toBe(
			true,
		);

		entries.push(job("j1", () => shell("m1")));
		recording.changed();
		entries.length = 0;
		recording.changed();
		expect(notes.has("s1"), "nothing runs, so nothing is noted").toBe(false);
	});

	it("moves its note to the session it rolled over to", () => {
		const notes = new Map<string, RunningNote>();
		const at = { session: "s1", now: 0 };
		const { recording } = recorder(
			[job("j1", () => shell("m1"))],
			[],
			at,
			[],
			notes,
		);
		recording.changed();
		at.session = "s2";
		recording.changed();
		expect([...notes.keys()], "only the session it is now").toEqual(["s2"]);
	});

	it("takes its note back at a close for good", () => {
		const notes = new Map<string, RunningNote>();
		const { recording } = recorder(
			[job("j1", () => shell("m1"))],
			[],
			undefined,
			[],
			notes,
		);
		recording.changed();
		recording.forget();
		expect(notes.size, "a close stops what was noted").toBe(0);
	});
});

describe("taking recorded jobs up", () => {
	const kept = (id: string): KeptJob => ({
		session: "s1",
		id,
		kind: "bash",
		label: `run ${id}`,
		work: shell(id),
	});

	it("carries what the session doesn't already hold", () => {
		expect(
			recordedCarry("s1", new Set(["j1"]), 7, () => [kept("j1"), kept("j2")]),
		).toEqual({
			at: 7,
			jobs: [{ id: "j2", kind: "bash", label: "run j2", work: shell("j2") }],
			results: [],
		});
	});

	it("carries nothing when every recorded job is held", () => {
		expect(
			recordedCarry("s1", new Set(["j1"]), 7, () => [kept("j1")]),
		).toBeUndefined();
	});
});

describe("a cut-off once its jobs are taken up", () => {
	const cut = {
		at: 1,
		running: false,
		jobs: [
			{ id: "j1", label: "run j1" },
			{ id: "j2", label: "run j2" },
		],
	};

	it("names only the jobs still dead", () => {
		expect(leftDead(cut, new Set(["j1"]))?.jobs).toEqual([
			{ id: "j2", label: "run j2" },
		]);
	});

	it("says nothing when every job lives on and no run was cut", () => {
		expect(leftDead(cut, new Set(["j1", "j2"]))).toBeUndefined();
	});

	it("still says a run was cut, when one was", () => {
		expect(leftDead({ ...cut, running: true }, new Set(["j1", "j2"]))).toEqual({
			at: 1,
			running: true,
			jobs: [],
		});
	});

	it("says nothing of a run its host carried on, once its jobs live on", () => {
		expect(
			leftDead(
				{ ...cut, running: true, runCarried: true },
				new Set(["j1", "j2"]),
			),
		).toBeUndefined();
	});

	it("is left whole when nothing was taken up", () => {
		expect(leftDead(cut, new Set())).toBe(cut);
	});
});
