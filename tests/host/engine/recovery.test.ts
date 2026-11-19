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

/**
 * Letting pi's run go as PiRuns' release does: the first call does the
 * work, and fails as `refused` does; any later call does nothing.
 */
function releasingOnce(refused: Error): () => Promise<void> {
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		throw refused;
	};
}

/**
 * A side that carries a turn on, letting pi's run go as `release` does,
 * its carried run ending as `ended` says once it has started.
 */
function carrying(
	release: () => Promise<void>,
	ended: () => Promise<void> = async () => {},
) {
	const stub = {
		active: () => undefined,
		parked: () => false,
		joelTyped: () => false,
		parking: new AbortController().signal,
		state: { messages: [] },
		transcript: { placeAtSession: async () => {} },
		durable: {
			runFailure: async () => undefined,
			carrying: async () => true,
			resume: () => {},
		},
		holdPiRun: () => release,
		runWithLifecycle: async (start: (run: unknown) => Promise<void>) => {
			const run = { controller: new AbortController() };
			await start(run);
			await ended();
			return run;
		},
	};
	return stub as unknown as RecoverySide;
}

describe("a recovery", () => {
	it("gives the carried run's turn back though its run fails and letting pi's run go fails too", async () => {
		const refused = new Error("pi's settle threw");
		let givenBack = 0;
		const recovery = new Recovery(
			carrying(releasingOnce(refused), () =>
				Promise.reject(new Error("the model failed")),
			),
		);

		const { settled } = await recovery.recover(async () => () => {
			givenBack += 1;
		});
		await expect(
			settled,
			"the settle's failure reaches the caller",
		).rejects.toBe(refused);

		expect(
			givenBack,
			"the turn the carried run took is given back once, whatever letting pi's run go did",
		).toBe(1);
	});

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
