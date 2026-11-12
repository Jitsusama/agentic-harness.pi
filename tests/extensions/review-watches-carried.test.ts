/**
 * A checks watch and a round's watch wait on work outside the process,
 * so a move to a host carries them: the old pi stops looking and says
 * nothing, and the host watches on under the same job id.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	CHECKS_WATCH_MS,
	takeUpChecks,
	watchChecks,
} from "../../extensions/review-integration/checks-job.ts";
import {
	takeUpRound,
	watchStartedRound,
} from "../../extensions/review-integration/round-job.ts";
import type {
	ChecksRollup,
	ReviewTarget,
} from "../../lib/core/review/index.ts";
import {
	announceJobHost,
	type Job,
	type JobOutcome,
	type JobSpec,
	jobStopReason,
} from "../../lib/jobs/index.ts";
import { until } from "../support/until.ts";

/** A few polls of the 5 ms the watches here look at. */
const A_FEW_LOOKS_MS = 60;

const controllers: AbortController[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
	for (const controller of controllers.splice(0))
		controller.abort(jobStopReason("session"));
	for (const dispose of disposers.splice(0)) dispose();
});

/** A job, recording what it says. */
function fakeJob(id: string) {
	const controller = new AbortController();
	controllers.push(controller);
	const outcomes: JobOutcome[] = [];
	const job: Job = {
		id,
		signal: controller.signal,
		finish: (outcome) => outcomes.push(outcome),
		onDelivered: () => {},
		withdraw: () => false,
	};
	return { job, outcomes, controller };
}

/** A host keeping each job's spec, so a test can ask what a move carries. */
function recordingHost() {
	const bus = createEventBus();
	const specs: JobSpec[] = [];
	const jobs: ReturnType<typeof fakeJob>[] = [];
	disposers.push(
		announceJobHost(bus, {
			start(spec): Job {
				specs.push(spec);
				const made = fakeJob(`j${jobs.length + 1}`);
				jobs.push(made);
				return made.job;
			},
		}),
	);
	return { bus, specs, jobs };
}

const target: ReviewTarget = {
	kind: "change",
	change: {
		provider: "github",
		repo: { key: "github:shop/app" },
		id: "7",
		label: "shop/app#7",
	},
};

const rollup = (state: ChecksRollup["state"]): ChecksRollup => ({
	state,
	checks: [],
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a checks watch through a move", () => {
	function watching(key: string, withTarget = true) {
		const host = recordingHost();
		let looks = 0;
		const job = watchChecks({
			bus: host.bus,
			key,
			label: "shop/app#7",
			...(withTarget ? { target } : {}),
			read: async () => {
				looks += 1;
				return rollup("pending");
			},
			render: (r) => `state ${r.state}`,
			pollMs: 5,
			now: () => 1000,
		});
		if (typeof job === "string") throw new Error(`refused: ${job}`);
		return { ...host, looks: () => looks };
	}

	it("writes down its target, its start and how long it may watch", () => {
		const { specs } = watching("gh:carry-1");
		expect(specs[0]?.carry?.what()).toEqual({
			kind: "review-checks",
			key: "gh:carry-1",
			label: "shop/app#7",
			target,
			startedAt: 1000,
			watchMs: CHECKS_WATCH_MS,
		});
	});

	it("holds a move when it names no target", () => {
		const { specs } = watching("gh:carry-2", false);
		expect(specs[0]?.carry, "no carry, so it holds").toBeUndefined();
	});

	it("stops looking and says nothing once handed on", async () => {
		const { specs, jobs, looks } = watching("gh:carry-3");
		await until("a first look", () => looks() > 0);
		specs[0]?.carry?.handed();
		const after = looks();
		// A real pause is the point: no look may come in the time several would.
		await pause(A_FEW_LOOKS_MS);
		expect(looks(), "no look after the hand-off").toBe(after);
		expect(jobs[0]?.outcomes, "nothing said here").toEqual([]);
		expect(specs[0]?.carry?.what(), "nothing left to carry").toBeUndefined();
	});

	it("watches on where it was taken up, and says the settled result", async () => {
		const { specs } = watching("gh:carry-4");
		const work = specs[0]?.carry?.what();
		specs[0]?.carry?.handed();
		if (work === undefined) throw new Error("nothing was carried");
		const bound: ReviewTarget[] = [];
		const taking = takeUpChecks(work, {
			reading: async (named) => {
				bound.push(named);
				return {
					read: async () => rollup("passing"),
					render: (r) => `state ${r.state}`,
				};
			},
			pollMs: 5,
			now: () => 2000,
		});
		const { job, outcomes } = fakeJob("j1");
		taking?.start(job);
		await until("the settled result", () => outcomes.length > 0);
		expect(bound, "the target bound again here").toEqual([target]);
		expect(outcomes).toEqual([
			{ summary: "Checks on shop/app#7 have settled: passing.\nstate passing" },
		]);
	});

	it("keeps the deadline it started with", async () => {
		const { specs } = watching("gh:carry-5");
		const work = specs[0]?.carry?.what();
		specs[0]?.carry?.handed();
		if (work === undefined) throw new Error("nothing was carried");
		const taking = takeUpChecks(work, {
			reading: async () => ({
				read: async () => rollup("pending"),
				render: (r) => `state ${r.state}`,
			}),
			pollMs: 5,
			now: () => 1000 + CHECKS_WATCH_MS,
		});
		const { job, outcomes } = fakeJob("j1");
		taking?.start(job);
		await until("the watch to give up", () => outcomes.length > 0);
		expect(outcomes[0]?.summary).toMatch(
			/still pending after two hours of watching/,
		);
	});

	it("says it can't watch here when nothing serves the change", async () => {
		const { specs } = watching("gh:carry-6");
		const work = specs[0]?.carry?.what();
		specs[0]?.carry?.handed();
		if (work === undefined) throw new Error("nothing was carried");
		const taking = takeUpChecks(work, { reading: async () => undefined });
		const { job, outcomes } = fakeJob("j1");
		taking?.start(job);
		await until("the failure said", () => outcomes.length > 0);
		expect(outcomes[0]).toMatchObject({ failed: true });
		expect(outcomes[0]?.summary).toMatch(/can't be read here/);
	});

	it("moves on again, unwatched here, when handed on before it was bound", async () => {
		const { specs } = watching("gh:carry-7");
		const work = specs[0]?.carry?.what();
		specs[0]?.carry?.handed();
		if (work === undefined) throw new Error("nothing was carried");
		let bind: (() => void) | undefined;
		let looks = 0;
		const taking = takeUpChecks(work, {
			reading: () =>
				new Promise((resolve) => {
					bind = () =>
						resolve({
							read: async () => {
								looks += 1;
								return rollup("passing");
							},
							render: (r) => `state ${r.state}`,
						});
				}),
			pollMs: 5,
		});
		const { job, outcomes } = fakeJob("j1");
		taking?.start(job);
		expect(taking?.carry?.what(), "carried as it came").toEqual(work);
		taking?.carry?.handed();
		bind?.();
		// A real pause is the point: no look may come in the time several would.
		await pause(A_FEW_LOOKS_MS);
		expect(looks, "never looked here").toBe(0);
		expect(outcomes).toEqual([]);
	});

	it("is not taken up from work it can't read", () => {
		expect(
			takeUpChecks(
				{ kind: "review-checks", key: "k" },
				{ reading: async () => undefined },
			),
		).toBeUndefined();
	});
});

describe("a round's watch through a move", () => {
	function watching() {
		const host = recordingHost();
		const stops: string[] = [];
		watchStartedRound({
			bus: host.bus,
			runId: "run-1",
			label: "council run-1 on shop/app#7",
			participants: ["alpha", "beta"],
			isRunning: async () => true,
			stop: async () => {
				stops.push("run-1");
			},
			pollMs: 5,
		});
		return { ...host, stops };
	}

	it("writes down the run and its reviewers", () => {
		const { specs } = watching();
		expect(specs[0]?.carry?.what()).toEqual({
			kind: "review-round",
			runId: "run-1",
			label: "council run-1 on shop/app#7",
			participants: ["alpha", "beta"],
		});
	});

	it("leaves the round running when handed on", async () => {
		const { specs, jobs, stops } = watching();
		specs[0]?.carry?.handed();
		jobs[0]?.controller.abort(jobStopReason("session"));
		// A real pause is the point: no stop may come in the time several looks would.
		await pause(A_FEW_LOOKS_MS);
		expect(stops, "the round is not stopped").toEqual([]);
		expect(jobs[0]?.outcomes).toEqual([]);
	});

	it("watches on where it was taken up, and says when to collect", async () => {
		const { specs } = watching();
		const work = specs[0]?.carry?.what();
		specs[0]?.carry?.handed();
		if (work === undefined) throw new Error("nothing was carried");
		const asked: unknown[] = [];
		const taking = takeUpRound(work, (runId, participants) => {
			asked.push([runId, participants]);
			return {
				isRunning: async () => false,
				stop: async () => {},
				pollMs: 5,
			};
		});
		const { job, outcomes } = fakeJob("j1");
		taking?.start(job);
		await until("the round said ready", () => outcomes.length > 0);
		expect(asked).toEqual([["run-1", ["alpha", "beta"]]]);
		expect(outcomes[0]?.summary).toMatch(/run-1 has no reviewer left running/);
	});

	it("holds a move when it names no reviewers", () => {
		const host = recordingHost();
		watchStartedRound({
			bus: host.bus,
			runId: "run-2",
			label: "council run-2",
			isRunning: async () => true,
			stop: async () => {},
			pollMs: 5,
		});
		expect(host.specs[0]?.carry).toBeUndefined();
	});
});
