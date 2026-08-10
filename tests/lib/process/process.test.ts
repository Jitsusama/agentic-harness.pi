/**
 * Saying which process you meant.
 *
 * The rules here are small and the consequences of getting one wrong
 * are not: every caller uses this to decide whether something may be
 * taken away, so a reading that is confidently wrong reclaims a tree
 * somebody is working in or kills a round somebody is waiting on.
 */

import { describe, expect, it } from "vitest";
import {
	isOwner,
	type Owner,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
	sameProcess,
	systemFacts,
} from "../../../lib/process/index.js";

/** A machine where these pids run, and started when it says. */
function machine(running: Record<number, number | undefined>): ProcessFacts {
	return {
		alive: (pid) => pid in running,
		startedAt: async (pid) => running[pid],
	};
}

const ours: Owner = { pid: 4001, startedAt: 1_000_000 };

describe("whether two readings are one process", () => {
	it("allows the second the process table rounds away", () => {
		// `ps` reports whole seconds against a recorded millisecond, so
		// the same process reads differently either side of a second.
		expect(sameProcess(1_000_900, 1_000_000)).toBe(true);
	});

	it("refuses a reading that is far earlier, not just far later", () => {
		// Two-sided deliberately. A truncated pid can name `1`, and `1`
		// started at boot, which is emphatically earlier: one-sided, it
		// passes, and the caller then signals init's process group.
		expect(sameProcess(1_000_000, 9_000_000)).toBe(false);
		expect(sameProcess(9_000_000, 1_000_000)).toBe(false);
	});
});

describe("whether a record identifies anybody", () => {
	it("wants both halves, since a pid alone is whoever holds it next", () => {
		expect(isOwner({ pid: 4001, startedAt: 1 })).toBe(true);
		expect(isOwner({ pid: 4001 })).toBe(false);
		expect(isOwner({ startedAt: 1 })).toBe(false);
	});

	it("refuses a pid no process can have", () => {
		// Zero is every process in this group to `kill`, and a negative
		// pid is the group itself. A record carrying either is one a
		// caller must not act on.
		expect(isOwner({ pid: 0, startedAt: 1 })).toBe(false);
		expect(isOwner({ pid: -1, startedAt: 1 })).toBe(false);
	});

	it("refuses what is not a record at all", () => {
		expect(isOwner(null)).toBe(false);
		expect(isOwner(undefined)).toBe(false);
		expect(isOwner("4001")).toBe(false);
	});
});

describe("writing down who we are", () => {
	it("says nothing rather than half an identity", async () => {
		// A pid with no start time is a record a later reader must
		// either trust blindly or throw away, and declining to write
		// one is how this avoids forcing that choice on anybody.
		expect(await ownerNow(machine({}), 4001)).toBeUndefined();
	});

	it("pairs the pid with when it started", async () => {
		expect(await ownerNow(machine({ 4001: 1_000_000 }), 4001)).toEqual(ours);
	});
});

describe("where the process that wrote a record stands", () => {
	it("is running when the pid is alive and started when it says", async () => {
		expect(await ownerStanding(ours, machine({ 4001: 1_000_000 }))).toBe(
			"running",
		);
	});

	it("is gone when nothing wears the pid", async () => {
		expect(await ownerStanding(ours, machine({}))).toBe("gone");
	});

	it("is gone when a stranger wears the pid", async () => {
		// Identity outranks liveness. The number is in use, which is
		// exactly what makes this the dangerous case rather than a
		// harmless one.
		expect(await ownerStanding(ours, machine({ 4001: 9_000_000 }))).toBe(
			"gone",
		);
	});

	it("is undecidable when the pid is alive and unidentifiable", async () => {
		// Distinct from gone on purpose. A caller about to delete
		// something must treat this as still there, and it could not do
		// that if this answered with the confident word.
		expect(await ownerStanding(ours, machine({ 4001: undefined }))).toBe(
			"unknown",
		);
	});
});

describe("what the machine itself says", () => {
	it("knows this process is running", async () => {
		expect(systemFacts.alive(process.pid)).toBe(true);
		expect(await systemFacts.startedAt(process.pid)).toBeGreaterThan(0);
	});

	it("reads a process it may not signal as alive, not as gone", () => {
		// Pid 1 is running and not ours to signal, so `kill(1, 0)`
		// raises EPERM. Collapsing that into "gone" was safe reasoning
		// for a supervisor we spawned, since one we cannot signal
		// cannot be ours, and is not safe for a worktree whose holder
		// can be another user's session.
		expect(systemFacts.alive(1)).toBe(true);
	});

	it("says nothing about a pid nothing wears", async () => {
		// Above the system maximum, so it cannot be allocated.
		expect(await systemFacts.startedAt(0x7f_ff_ff_ff)).toBeUndefined();
	});
});
