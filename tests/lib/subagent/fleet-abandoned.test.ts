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
function machine(
	processes: Record<number, number | undefined>,
	asked: number[] = [],
): ProcessFacts {
	return {
		alive: (pid) => pid in processes,
		startedAt: async (pid) => {
			asked.push(pid);
			return processes[pid];
		},
	};
}

/**
 * When a session started, as the machine would report it.
 *
 * An epoch millisecond rather than a small number, and that matters
 * more than it looks. These are compared with a two-second tolerance,
 * so a fixture of 1000 sits within tolerance of zero, and a bug that
 * turned an unreadable birthday into zero went unnoticed by every
 * case in this file until a mutant said so.
 */
const BIRTHDAY = 1_760_000_000_000;

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
		const runs = [open("fleet-orphan", { pid: 4242, startedAt: BIRTHDAY })];

		const abandoned = await abandonedFleets(runs, machine({}));

		expect(abandoned.map((one) => one.id)).toEqual(["fleet-orphan"]);
	});

	it("leaves a fleet whose session is still waiting", async () => {
		// The case that makes this worth doing carefully. Cancelling a
		// fleet somebody is sitting in front of, waiting on, is worse
		// than leaving an orphan to its backstop.
		const runs = [open("fleet-live", { pid: 4242, startedAt: BIRTHDAY })];

		const abandoned = await abandonedFleets(runs, machine({ 4242: BIRTHDAY }));

		expect(abandoned).toEqual([]);
	});

	it("names a fleet whose pid is worn by something else now", async () => {
		// A pid identifies nothing on its own. The session died, the
		// number came round again, and the stranger wearing it is alive,
		// so liveness alone answers that somebody is still waiting.
		const runs = [open("fleet-recycled", { pid: 4242, startedAt: BIRTHDAY })];

		const abandoned = await abandonedFleets(
			runs,
			machine({ 4242: BIRTHDAY + 9_000_000 }),
		);

		expect(abandoned.map((one) => one.id)).toEqual(["fleet-recycled"]);
	});

	it("leaves a fleet whose owner cannot be identified but is alive", async () => {
		// A platform that will not report a start time leaves liveness as
		// the only evidence, and it fails open. That is the wrong
		// direction, so it is what happens when there is nothing better
		// rather than what happens by default: the cost of being wrong
		// here is cancelling a fleet somebody is waiting on.
		const runs = [open("fleet-unknown", { pid: 4242, startedAt: BIRTHDAY })];

		const abandoned = await abandonedFleets(runs, machine({ 4242: undefined }));

		expect(abandoned).toEqual([]);
	});

	it("allows for the two clocks disagreeing slightly", async () => {
		// The same tolerance the supervisor lease uses, and it has to be
		// exercised rather than jumped over: every other case here is
		// thousands of seconds out, which a comparison with no tolerance
		// at all would answer identically. A process start time is read
		// from `ps` in whole seconds, so an exact match is not something
		// two readings can be relied on to produce.
		const runs = [open("fleet-live", { pid: 4242, startedAt: BIRTHDAY })];

		const abandoned = await abandonedFleets(
			runs,
			machine({ 4242: BIRTHDAY + 900 }),
		);

		expect(abandoned).toEqual([]);
	});

	it("sorts a mixed ledger, asking about each session once", async () => {
		// Two things at once, and both of them only appear in bulk. The
		// cases above hold one fleet each, so nothing there would notice
		// a function that returned the first answer it found rather than
		// every one, and nothing would notice a subprocess per fleet.
		//
		// The count is the point of the second. This population is the
		// one designed to grow, so a hundred fleets from one dead
		// session must not be a hundred forks at session start.
		const asked: number[] = [];
		const runs = [
			open("gone-1", { pid: 4242, startedAt: BIRTHDAY }),
			open("live-1", { pid: 7, startedAt: BIRTHDAY }),
			open("gone-2", { pid: 4242, startedAt: BIRTHDAY }),
			open("live-2", { pid: 7, startedAt: BIRTHDAY }),
			open("gone-3", { pid: 4242, startedAt: BIRTHDAY }),
		];

		const abandoned = await abandonedFleets(
			runs,
			// Both alive, so both are asked about: one is this session
			// still waiting, the other a stranger wearing the number.
			machine({ 4242: BIRTHDAY + 9_000_000, 7: BIRTHDAY }, asked),
		);

		expect(abandoned.map((one) => one.id)).toEqual([
			"gone-1",
			"gone-2",
			"gone-3",
		]);
		expect(asked).toEqual([4242, 7]);
	});

	it("says nothing about a fleet somebody was already handed", async () => {
		// A settled fleet went to whoever asked for it, and what became
		// of that session afterwards says nothing about it: every
		// session ends eventually, so a dead owner is the ordinary state
		// of a settled record. Decided here rather than asked of the
		// caller, since a precondition living at one call site is one
		// the next caller cannot know about.
		const runs: FleetRun[] = [
			{
				id: "fleet-handed-over",
				startedAt: new Date().toISOString(),
				jobs: ["one"],
				settledAt: new Date().toISOString(),
				owner: { pid: 4242, startedAt: BIRTHDAY },
			},
		];

		const abandoned = await abandonedFleets(runs, machine({}));

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
