/** Carrying on what a restart cut off, through a side standing in for the agent's. */
import { describe, expect, it } from "vitest";
import {
	Recovery,
	type RecoverySide,
} from "../../../host/engine/hosted-agent/recovery.ts";

/** The side a recovery with nothing to carry reads, its runs starting as `start` does. */
function side(start: RecoverySide["runWithLifecycle"]) {
	const holds = { taken: 0, released: 0 };
	const stub = {
		active: () => undefined,
		parked: () => false,
		transcript: { placeAtSession: async () => {} },
		durable: { runFailure: async () => undefined },
		holdPiRun: () => {
			holds.taken += 1;
			return async () => {
				holds.released += 1;
			};
		},
		runWithLifecycle: start,
	};
	return { side: stub as unknown as RecoverySide, holds };
}

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
});
