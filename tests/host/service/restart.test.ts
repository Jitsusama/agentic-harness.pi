/** When a host restarts itself: only once it would differ and all is settled. */
import { describe, expect, it } from "vitest";
import {
	HELD_SAY_MS,
	type Held,
	LOOK_MS,
	RESTART_DUE_MS,
	restartWhenSettled,
	SETTLE_CEILING_MS,
	settled,
} from "../../../host/service/restart.ts";
import { facts, lately, long, manualTimers, NOW } from "./restart-fakes.ts";

describe("settled", () => {
	it("needs every conversation idle or parked, and unchanged long enough", () => {
		const parked: Held = { state: "parked", since: long };
		expect(settled([], NOW), "a host holding nothing").toBe(true);
		expect(
			settled([{ state: "idle", since: long }, parked], NOW),
			"one idle and one parked, both long since",
		).toBe(true);
		expect(settled([{ state: "busy", since: long }], NOW), "one running").toBe(
			false,
		);
		expect(
			settled([{ state: "idle", since: lately }], NOW),
			"one that just finished",
		).toBe(false);
	});
});

describe("restartWhenSettled", () => {
	it("first looks after the first wait, then every look", async () => {
		const timers = manualTimers();
		const { facts: given } = facts({ differs: async () => undefined });
		restartWhenSettled(given, {
			after: timers.after,
			firstLookMs: 300,
			lookMs: 60,
		});
		expect(timers.pending().map(({ ms }) => ms)).toEqual([300]);
		await timers.fire();
		expect(timers.pending().map(({ ms }) => ms)).toEqual([60]);
	});

	it("expects the restart, then asks for it once, when it differs and all is settled", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts();
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual(["expect true", "restart: the install moved"]);
		expect(
			timers.pending().map(({ ms }) => ms),
			"only the wait for systemd to run it",
		).toEqual([RESTART_DUE_MS]);
	});

	it("stops expecting a restart systemd queued but never ran, and looks again", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({ differs: async () => undefined });
		let first = true;
		given.differs = async () => {
			const why = first ? "the install moved" : undefined;
			first = false;
			return why;
		};
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		await timers.fire();
		expect(said).toEqual([
			"expect true",
			"restart: the install moved",
			"expect false",
			"report: systemd queued the host's restart but never ran it; looking again",
		]);
		expect(timers.pending().map(({ ms }) => ms)).toEqual([60]);
	});

	it("expects no restart systemd refused, and looks again", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			restart: async () => {
				throw new Error("refused");
			},
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual([
			"expect true",
			"expect false",
			"report: Error: refused",
		]);
		expect(
			timers.pending().map(({ ms }) => ms),
			"a look's wait, with no heap pressing",
		).toEqual([LOOK_MS]);
	});

	it.each([
		["nothing differs", { differs: async () => undefined }],
		[
			"a conversation runs",
			{ held: (): readonly Held[] => [{ state: "busy", since: long }] },
		],
		[
			"a conversation changed lately",
			{ held: (): readonly Held[] => [{ state: "idle", since: lately }] },
		],
		["a screen is in use", { resting: () => false }],
		["background work is held", { background: () => 1 }],
	])("waits while %s", async (_why, overrides) => {
		const timers = manualTimers();
		const { facts: given, said } = facts(overrides);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual([]);
		expect(timers.pending(), "it looks again").toHaveLength(1);
	});

	// The background host on 12 November: its conversations took turns for
	// 14.5 hours and were never all idle 2 minutes at once, so it never
	// restarted onto the code its install had moved to (OSPHT4 07d3baff).
	it("restarts in a gap between turns once it has waited past the ceiling, never mid-turn", async () => {
		const TURN_MS = 90_000;
		const GAP_MS = 5000;
		const CYCLE_MS = 2 * (TURN_MS + GAP_MS);
		let clock = NOW;
		// One runs 90 s, both rest 5 s, the other runs 90 s, both rest 5 s.
		const one = (start: number): Held => {
			const at = (((clock - NOW - start) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
			return at < TURN_MS
				? { state: "busy", since: new Date(clock - at).toISOString() }
				: {
						state: "idle",
						since: new Date(clock - (at - TURN_MS)).toISOString(),
					};
		};
		const held = (): readonly Held[] => [one(0), one(TURN_MS + GAP_MS)];
		const timers = manualTimers();
		const seen: Held[][] = [];
		const { facts: given, said } = facts({ held, now: () => clock });
		given.restart = async (why, under) => {
			seen.push([...held()]);
			said.push(`restart under ${under.rule}: ${why}`);
		};
		restartWhenSettled(given, { after: timers.after });
		const giveUp = NOW + 2 * 60 * 60_000;
		while (!said.some((line) => line.startsWith("restart")) && clock < giveUp) {
			clock += timers.pending()[0]?.ms ?? 0;
			await timers.fire();
		}

		expect(
			said.filter((line) => line.startsWith("restart")),
			"it restarted once, saying the rule it restarted under",
		).toEqual(["restart under ceiling: the install moved"]);
		expect(
			clock - NOW,
			"not before it had waited the ceiling for every one to settle",
		).toBeGreaterThanOrEqual(SETTLE_CEILING_MS);
		expect(
			seen[0]?.map(({ state }) => state),
			"in a gap, with no conversation running",
		).toEqual(["idle", "idle"]);
	});

	// The background host on 13 November: a throw began its stop at
	// 18:26:46, which parked five turns mid-way, and at 18:26:50 the loop
	// read the parked host as quiet and asked systemd for a restart on top.
	it("asks for no restart once the host has begun stopping, settled or past the ceiling", async () => {
		for (const ceilingMs of [SETTLE_CEILING_MS, 0]) {
			const timers = manualTimers();
			const { facts: given, said } = facts({
				held: () => [{ state: "parked", since: long }],
				stopping: () => true,
			});
			restartWhenSettled(given, { after: timers.after, ceilingMs });
			await timers.fire();
			await timers.fire();
			expect(said, "nothing restarted").toEqual([]);
		}
	});

	it("still waits past the ceiling while background work is held or a screen is in use", async () => {
		for (const overrides of [
			{ background: () => 1 },
			{ resting: () => false },
		]) {
			const timers = manualTimers();
			const { facts: given, said } = facts({
				held: () => [{ state: "idle", since: lately }],
				...overrides,
			});
			restartWhenSettled(given, { after: timers.after, ceilingMs: 0 });
			await timers.fire();
			await timers.fire();
			expect(
				said.filter((line) => !line.startsWith("report:")),
				"nothing restarted",
			).toEqual([]);
		}
	});

	// On 13 November a background bash always running kept both work hosts
	// on old code for hours, and nothing said why (QCXZEB).
	it("names what holds a restart past the ceiling, once an hour, ending nothing", async () => {
		let clock = NOW;
		const timers = manualTimers();
		const { facts: given, said } = facts({
			background: () => 1,
			// A label a model wrote may carry a line break, which would forge a line.
			holding: () => ["s1: j1 subagent:\u0000review"],
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after, ceilingMs: 0 });
		for (let look = 0; look < 5; look++) {
			clock += 60_000;
			await timers.fire();
		}
		clock += HELD_SAY_MS;
		await timers.fire();

		expect(said).toEqual([
			"report: Restart held past the ceiling by background work: s1: j1 subagent: review",
			"report: Restart held past the ceiling by background work: s1: j1 subagent: review",
		]);
		expect(said.join(""), "no line break left in what it said").not.toMatch(
			/\p{Cc}/u,
		);
	});

	it("names nothing while held before the ceiling", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			background: () => 1,
			holding: () => ["s1: j1 subagent: review"],
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		await timers.fire();
		expect(said).toEqual([]);
	});

	it("reports a look that failed and looks again", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => {
				throw new Error("unreadable");
			},
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual(["report: Error: unreadable"]);
		expect(
			timers.pending().map(({ ms }) => ms),
			"a look's wait, with no heap pressing",
		).toEqual([LOOK_MS]);
	});

	it("looks no more once stopped", async () => {
		const timers = manualTimers();
		const { facts: given } = facts();
		const stop = restartWhenSettled(given, { after: timers.after });
		stop();
		expect(timers.pending()).toEqual([]);
	});
});
