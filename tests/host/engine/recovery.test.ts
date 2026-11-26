/** Carrying on what a restart cut off, through a side standing in for the agent's. */
import { describe, expect, it } from "vitest";
import {
	Recovery,
	type RecoverySide,
} from "../../../host/engine/hosted-agent/recovery.ts";
import type { Run } from "../../../host/engine/hosted-agent/run.ts";

/** The side a recovery with nothing to carry reads, its runs starting as `start` does. */
function side(
	start: RecoverySide["runWithLifecycle"],
	markCompaction: RecoverySide["markCompaction"] = async () => {},
) {
	const holds = { taken: 0, released: 0 };
	const reported: unknown[] = [];
	const resumed = { times: 0 };
	const stub = {
		report: (error: unknown) => reported.push(error),
		active: () => undefined,
		parked: () => false,
		transcript: { placeAtSession: async () => {} },
		state: { messages: [] },
		markCompaction,
		durable: {
			runFailure: async () => undefined,
			resume: () => {
				resumed.times += 1;
			},
		},
		holdPiRun: () => {
			holds.taken += 1;
			return async () => {
				holds.released += 1;
			};
		},
		runWithLifecycle: start,
	};
	return { side: stub as unknown as RecoverySide, holds, reported, resumed };
}

/** Start a recovery's run at once, as the agent's lifecycle does with no run before it. */
const startsAtOnce: RecoverySide["runWithLifecycle"] = async (start) => {
	const run = { controller: new AbortController() } as unknown as Run;
	await start(run);
	return run;
};

describe("a recovery", () => {
	it("lets pi's run go when its run fails before it starts", async () => {
		const failed = new Error("durable refused the run");
		const { side: agent, holds } = side(() => Promise.reject(failed));

		await expect(new Recovery(agent).recover()).rejects.toBe(failed);
		await new Promise((done) => setImmediate(done));

		expect(
			holds,
			"pi's run is held for the recovery and let go once its run failed",
		).toEqual({ taken: 1, released: 1 });
	});

	it("resumes durable when marking pi's compaction fails, saying why", async () => {
		const failed = new Error("durable's log couldn't be read");
		const {
			side: agent,
			reported,
			resumed,
		} = side(startsAtOnce, () => Promise.reject(failed));

		const { settled } = await new Recovery(agent).recover();
		await settled;

		expect(resumed.times, "durable resumed all the same").toBe(1);
		expect(reported, "the failed marking was said").toEqual([failed]);
	});
});
