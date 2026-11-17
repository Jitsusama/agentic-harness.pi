/**
 * Each running bash job recorded once under its session, asked again
 * while its call has nothing to record yet; taken up again as a carry
 * of what the session doesn't already hold; and a cut-off notice that
 * calls no job dead the session took up again.
 */

import { describe, expect, it } from "vitest";
import { leftDead } from "../../../extensions/job-workflow/cut-off.ts";
import type { JobEntry } from "../../../extensions/job-workflow/jobs.ts";
import {
	MOST_ASKS,
	recordedCarry,
	recordJobs,
} from "../../../extensions/job-workflow/recorded.ts";
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

/** A recorder over `entries` writing into `written`, its asks run by hand. */
function recorder(entries: JobEntry[], written: KeptJob[]) {
	const again: (() => void)[] = [];
	const recording = recordJobs(
		() => ({ list: () => entries }),
		() => "s1",
		{
			write: (kept) => written.push(kept),
			later: (_ms, run) => {
				again.push(run);
				return () => {
					again.splice(again.indexOf(run), 1);
				};
			},
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
				work: shell("m1"),
			},
		]);
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

	it("stops asking a call that never has anything to record", () => {
		const written: KeptJob[] = [];
		const { recording, again } = recorder(
			[job("j1", () => undefined)],
			written,
		);
		recording.changed();
		let asks = 1;
		while (again.length > 0) {
			const next = again.shift();
			next?.();
			asks += 1;
		}
		expect(asks, "asked at most this often").toBe(MOST_ASKS);
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

	it("asks nothing again once stopped", () => {
		const written: KeptJob[] = [];
		const { recording, again } = recorder(
			[job("j1", () => undefined)],
			written,
		);
		recording.changed();
		recording.stop();
		expect(again).toEqual([]);
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
		expect(
			leftDead({ ...cut, running: true }, new Set(["j1", "j2"])),
		).toEqual({ at: 1, running: true, jobs: [] });
	});

	it("is left whole when nothing was taken up", () => {
		expect(leftDead(cut, new Set())).toBe(cut);
	});
});
