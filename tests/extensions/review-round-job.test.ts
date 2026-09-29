/**
 * A started round is watched as a background job.
 *
 * `review_ask start` hands the session back at once, and until now
 * nothing told the model when the round was ready: it either polled,
 * spending a turn each time, or forgot. With a job host loaded the
 * round is held as a job, and when no reviewer is left running the
 * model is told to collect it. The watcher never collects on its own,
 * since a collect racing one the model starts would file findings
 * twice.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { watchStartedRound } from "../../extensions/review-integration/round-job.ts";
import {
	announceJobHost,
	type Job,
	type JobOutcome,
	type JobSpec,
	jobStopReason,
} from "../../lib/jobs/index.ts";

/** Wait until a condition holds, failing the test if it never does. */
async function until(condition: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A host that records what was started and how each job ended. */
function recordingHost() {
	const bus = createEventBus();
	const specs: JobSpec[] = [];
	const outcomes: JobOutcome[] = [];
	const controller = new AbortController();
	const dispose = announceJobHost(bus, {
		start(spec): Job {
			specs.push(spec);
			return {
				id: "j1",
				signal: controller.signal,
				finish: (outcome) => outcomes.push(outcome),
				onDelivered: () => {},
			};
		},
	});
	disposers.push(dispose);
	return { bus, specs, outcomes, controller };
}

const disposers: (() => void)[] = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

describe("a started round with a job host", () => {
	it("is held as a job, named for the round", () => {
		const { bus, specs, controller } = recordingHost();
		const job = watchStartedRound({
			bus,
			runId: "council-1",
			label: "council on shop/app#7",
			isRunning: async () => true,
			stop: async () => {},
			pollMs: 5,
		});
		expect(job?.id).toBe("j1");
		expect(specs).toEqual([{ kind: "review", label: "council on shop/app#7" }]);
		controller.abort(jobStopReason("session"));
	});

	it("tells the model to collect it once nothing is running", async () => {
		const { bus, outcomes } = recordingHost();
		let running = true;
		watchStartedRound({
			bus,
			runId: "council-1",
			label: "council",
			isRunning: async () => running,
			stop: async () => {},
			pollMs: 5,
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(outcomes).toHaveLength(0);
		running = false;
		await until(() => outcomes.length === 1);
		expect(outcomes[0]?.summary).toContain("review_ask collect run=council-1");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(outcomes).toHaveLength(1);
	});

	it("reads a check that failed as still running", async () => {
		const { bus, outcomes, controller } = recordingHost();
		let checks = 0;
		watchStartedRound({
			bus,
			runId: "council-1",
			label: "council",
			isRunning: async () => {
				checks++;
				throw new Error("ps timed out");
			},
			stop: async () => {},
			pollMs: 5,
		});
		await until(() => checks >= 3);
		expect(outcomes).toHaveLength(0);
		controller.abort(jobStopReason("session"));
	});

	it("looks once at a time, however slow a look is", async () => {
		const { bus, controller } = recordingHost();
		let checks = 0;
		watchStartedRound({
			bus,
			runId: "council-1",
			label: "council",
			isRunning: () => {
				checks++;
				return new Promise<boolean>(() => {});
			},
			stop: async () => {},
			pollMs: 5,
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(checks).toBe(1);
		controller.abort(jobStopReason("session"));
	});

	it("stops the round when the person stops the job", async () => {
		const { bus, controller } = recordingHost();
		let stopped = 0;
		watchStartedRound({
			bus,
			runId: "council-1",
			label: "council",
			isRunning: async () => true,
			stop: async () => {
				stopped++;
			},
			pollMs: 5,
		});
		controller.abort(jobStopReason("person"));
		await until(() => stopped === 1);
	});

	it("leaves the round running when only the session ends", async () => {
		const { bus, controller } = recordingHost();
		let stopped = 0;
		let checks = 0;
		watchStartedRound({
			bus,
			runId: "council-1",
			label: "council",
			isRunning: async () => {
				checks++;
				return true;
			},
			stop: async () => {
				stopped++;
			},
			pollMs: 5,
		});
		await until(() => checks >= 1);
		controller.abort(jobStopReason("session"));
		const after = checks;
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(stopped).toBe(0);
		expect(checks).toBeLessThanOrEqual(after + 1);
	});
});

describe("a started round with no job host", () => {
	it("is not watched, so start answers as it always has", () => {
		const job = watchStartedRound({
			bus: createEventBus(),
			runId: "council-1",
			label: "council",
			isRunning: async () => true,
			stop: async () => {},
		});
		expect(job).toBeUndefined();
	});
});
