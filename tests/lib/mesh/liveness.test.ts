/**
 * Liveness: whether a peer is still on the mesh, asked of the machine.
 */
import type { ProcessFacts } from "@jitsusama/agentic-harness.core/process";
import { describe, expect, it } from "vitest";
import {
	census,
	livenessOf,
	machineBooted,
	type PeerFacts,
	peerOwnerNow,
} from "../../../lib/mesh/liveness.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

/** A machine on which these pids run, started at these times. */
function machine(running: Record<number, number>): ProcessFacts & {
	asked: number[];
} {
	const asked: number[] = [];
	return {
		asked,
		alive: (pid) => pid in running,
		startedAt: async (pid) => {
			asked.push(pid);
			return running[pid];
		},
	};
}

const presence = (over: Partial<Presence> = {}): Presence => ({
	session: "s-1",
	addresses: ["P9R1KI"],
	groups: [],
	worksOn: "",
	owns: [],
	busy: false,
	at: "2026-10-22T03:00:00.000Z",
	...over,
});

describe("a peer's liveness", () => {
	it("is present while the process that holds it runs", async () => {
		const one = presence({ owner: { pid: 40, startedAt: 1000 } });

		expect(await livenessOf(one, machine({ 40: 1000 }))).toBe("present");
	});

	it("is gone once that process has ended", async () => {
		const one = presence({ owner: { pid: 40, startedAt: 1000 } });

		expect(await livenessOf(one, machine({}))).toBe("gone");
	});

	it("is gone when a new process wears its pid", async () => {
		const one = presence({ owner: { pid: 40, startedAt: 1000 } });

		expect(await livenessOf(one, machine({ 40: 900_000 }))).toBe("gone");
	});

	it("cannot be told for a presence that names no process", async () => {
		expect(await livenessOf(presence(), machine({}))).toBe("unknown");
	});
});

/**
 * A machine whose boot clock has moved by `drift` milliseconds since its
 * processes started, as suspends move it, keeping each start in ticks.
 */
function suspended(
	ticks: Record<number, number>,
	drift: number,
	boot = "boot-1",
): PeerFacts {
	return {
		alive: (pid) => pid in ticks,
		startedAt: async (pid) =>
			pid in ticks ? 1000 + (ticks[pid] ?? 0) * 10 + drift : undefined,
		bootId: () => boot,
		startTicks: async (pid) => ticks[pid],
	};
}

describe("a peer's liveness across a suspend", () => {
	const owner = { pid: 40, startedAt: 1500, bootId: "boot-1", startTicks: 50 };

	it("stays present though the boot clock moved past core's tolerance", async () => {
		const one = presence({ owner });

		expect(await livenessOf(one, suspended({ 40: 50 }, 4000))).toBe("present");
	});

	it("is gone when a new process wears its pid", async () => {
		const one = presence({ owner });

		expect(await livenessOf(one, suspended({ 40: 51 }, 0))).toBe("gone");
	});

	it("is gone after the machine booted again", async () => {
		const one = presence({ owner });

		expect(await livenessOf(one, suspended({ 40: 50 }, 0, "boot-2"))).toBe(
			"gone",
		);
	});

	it("is judged as before when its presence has no ticks", async () => {
		const { startTicks: _, ...old } = owner;

		expect(
			await livenessOf(presence({ owner: old }), suspended({ 40: 50 }, 4000)),
		).toBe("gone");
		expect(
			await livenessOf(presence({ owner: old }), suspended({ 40: 50 }, 0)),
		).toBe("present");
	});

	it("keeps the ticks through a census", async () => {
		const { present } = await census(
			[presence({ owner })],
			suspended({ 40: 50 }, 4000),
		);

		expect(present).toHaveLength(1);
	});

	it("names this process with its ticks", async () => {
		const now = await peerOwnerNow(suspended({ [process.pid]: 77 }, 0));

		expect(now).toMatchObject({ pid: process.pid, startTicks: 77 });
	});
});

describe("a census", () => {
	it("keeps the peers that cannot be told among those present", async () => {
		const there = presence({ owner: { pid: 40, startedAt: 1000 } });
		const old = presence({ session: "s-2", addresses: ["WCJQSG"] });
		const ended = presence({
			session: "s-3",
			addresses: ["OVAE1I"],
			owner: { pid: 41, startedAt: 1000 },
		});

		const { present, gone } = await census(
			[there, old, ended],
			machine({ 40: 1000 }),
		);

		expect(present.map((one) => one.session)).toEqual(["s-1", "s-2"]);
		expect(gone.map((one) => one.session)).toEqual(["s-3"]);
	});

	it("counts a session its process has moved on from as gone", async () => {
		// One pi holds one session at a time: /new leaves the last one behind.
		const owner = { pid: 40, startedAt: 1000 };
		const left = presence({ owner, at: "2026-10-22T03:00:00.000Z" });
		const now = presence({
			session: "s-2",
			owner,
			at: "2026-10-22T03:05:00.000Z",
		});

		const { present, gone } = await census([left, now], machine({ 40: 1000 }));

		expect(present.map((one) => one.session)).toEqual(["s-2"]);
		expect(gone.map((one) => one.session)).toEqual(["s-1"]);
	});

	it("asks the machine once per process", async () => {
		const owner = { pid: 40, startedAt: 1000 };
		const facts = machine({ 40: 1000 });

		await census(
			[presence({ owner }), presence({ session: "s-2", owner })],
			facts,
		);

		expect(facts.asked).toEqual([40]);
	});
});

describe("when the machine booted", () => {
	it("is the kernel's btime, in milliseconds", () => {
		const stat = "cpu  1 2 3\nintr 9\nbtime 1792864593\nprocesses 4\n";

		expect(machineBooted(() => stat)).toBe(1792864593000);
	});

	it("is nothing where the machine will not say", () => {
		expect(machineBooted(() => "cpu  1 2 3\n")).toBeUndefined();
		expect(
			machineBooted(() => {
				throw new Error("ENOENT: /proc/stat");
			}),
		).toBeUndefined();
	});
});
