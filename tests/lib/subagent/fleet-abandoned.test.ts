/**
 * Which open fleets nobody is waiting for any more.
 *
 * A fleet is dispatched by a session that then awaits it, and there is
 * no detached dispatch: nothing starts a fleet meaning to come back
 * for it later, the way a review round can be started and collected.
 * So a fleet still running after its session has gone is running for
 * nobody. Its supervisors hold expensive models open against their own
 * backstops, for hours, and the answer they eventually write has
 * nowhere to go.
 *
 * Telling that fleet from one running right now is the whole question,
 * and it cannot be answered from the transcripts: a live supervisor
 * looks the same either way. It is answered from who was waiting.
 */
import { describe, expect, it } from "vitest";
import { abandonedFleets, type FleetRun } from "../../../lib/subagent/fleet.js";
import type { ProcessFacts } from "../../../lib/subagent/lease.js";

/** A machine that says what these tests need it to say. */
function machine(processes: Record<number, number | undefined>): ProcessFacts {
	return {
		alive: (pid) => pid in processes,
		startedAt: async (pid) => processes[pid],
	};
}

/** An open fleet, dispatched by the given session. */
function open(id: string, owner?: FleetRun["owner"]): FleetRun {
	return {
		id,
		startedAt: new Date().toISOString(),
		jobs: ["one"],
		open: true,
		...(owner ? { owner } : {}),
	};
}

describe("abandoned fleets", () => {
	it("names a fleet whose session has gone", async () => {
		const runs = [open("fleet-orphan", { pid: 4242, startedAt: 1_000 })];

		const abandoned = await abandonedFleets(runs, machine({}));

		expect(abandoned.map((one) => one.id)).toEqual(["fleet-orphan"]);
	});

	it("leaves a fleet whose session is still waiting", async () => {
		// The case that makes this worth doing carefully. Cancelling a
		// fleet somebody is sitting in front of, waiting on, is worse
		// than leaving an orphan to its backstop.
		const runs = [open("fleet-live", { pid: 4242, startedAt: 1_000 })];

		const abandoned = await abandonedFleets(runs, machine({ 4242: 1_000 }));

		expect(abandoned).toEqual([]);
	});

	it("names a fleet whose pid is worn by something else now", async () => {
		// A pid identifies nothing on its own. The session died, the
		// number came round again, and the stranger wearing it is alive,
		// so liveness alone answers that somebody is still waiting.
		const runs = [open("fleet-recycled", { pid: 4242, startedAt: 1_000 })];

		const abandoned = await abandonedFleets(runs, machine({ 4242: 9_000_000 }));

		expect(abandoned.map((one) => one.id)).toEqual(["fleet-recycled"]);
	});

	it("leaves a fleet whose owner cannot be identified but is alive", async () => {
		// A platform that will not report a start time leaves liveness as
		// the only evidence, and it fails open. That is the wrong
		// direction, so it is what happens when there is nothing better
		// rather than what happens by default: the cost of being wrong
		// here is cancelling a fleet somebody is waiting on.
		const runs = [open("fleet-unknown", { pid: 4242, startedAt: 1_000 })];

		const abandoned = await abandonedFleets(runs, machine({ 4242: undefined }));

		expect(abandoned).toEqual([]);
	});

	it("leaves a record that never said who was waiting", async () => {
		// Written by a version that did not record an owner. Absent means
		// not told, and the safe reading of not being told is that
		// somebody is there.
		const runs = [open("fleet-old")];

		const abandoned = await abandonedFleets(runs, machine({}));

		expect(abandoned).toEqual([]);
	});
});
