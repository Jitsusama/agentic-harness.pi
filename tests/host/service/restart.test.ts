/**
 * When a host restarts itself: only once it would differ and all is
 * settled. Long because its cases cover restart.ts's three exports,
 * which decide one restart together: whether all is settled, when a
 * restart waits for it (each share of the heap, background work held, a
 * gap between turns, a call or a meeting), and what a host follows to
 * know it would differ.
 */
import {
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	followWhatStarts,
	HELD_SAY_MS,
	type Held,
	RESTART_DUE_MS,
	type RestartFacts,
	type RestartRule,
	restartWhenSettled,
	SETTLE_CEILING_MS,
	settled,
} from "../../../host/service/restart.ts";
import type { Systemctl } from "../../../host/service/what-starts.ts";

const NOW = Date.parse("2026-11-10T20:00:00Z");
const MB = 1024 * 1024;
const long = new Date(NOW - 10 * 60_000).toISOString();
const lately = new Date(NOW - 30_000).toISOString();

// Timers the test fires by hand, in the order they were set.
function manualTimers() {
	const waiting: { ms: number; run: () => void; cancelled: boolean }[] = [];
	return {
		after(ms: number, run: () => void) {
			const timer = { ms, run, cancelled: false };
			waiting.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		pending: () => waiting.filter((timer) => !timer.cancelled),
		/**
		 * Run the next timer and wait until its look is over: by default
		 * until it set the next, or until `over` says so for one that
		 * restarted and sets none.
		 */
		async fire(over = () => waiting.length > 0) {
			const timer = waiting.shift();
			if (!timer) throw new Error("No timer is waiting");
			if (!timer.cancelled) timer.run();
			await vi.waitFor(
				() => {
					if (!over()) throw new Error("The look hasn't finished");
				},
				// A look awaits only promises the test resolves at once.
				{ interval: 1 },
			);
		},
	};
}

function facts(overrides: Partial<RestartFacts> = {}) {
	const said: string[] = [];
	const base: RestartFacts = {
		differs: async () => "the install moved",
		held: () => [{ state: "idle", since: long }],
		background: () => 0,
		resting: () => true,
		stopping: () => false,
		expect: (coming) => said.push(`expect ${coming}`),
		restart: async (why) => {
			said.push(`restart: ${why}`);
		},
		report: (error) => said.push(`report: ${String(error)}`),
		now: () => NOW,
		...overrides,
	};
	return { facts: base, said };
}

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
		expect(timers.pending()).toHaveLength(1);
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
			holding: () => ["s1: j1 subagent: review"],
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

	// From 05:02 on 17 November a drain held every wake of 13 parked
	// sessions while background work kept its restart past the ceiling.
	it("says it waits for a gap once past the ceiling, and no longer as its restart is asked", async () => {
		let clock = NOW;
		let background = 1;
		const timers = manualTimers();
		const waits: boolean[] = [];
		const { facts: given, said } = facts({
			background: () => background,
			waitsForGap: (waiting) => waits.push(waiting),
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(waits, "before the ceiling").toEqual([]);

		clock += SETTLE_CEILING_MS;
		await timers.fire();
		await timers.fire();
		expect(waits, "at each gap look past it").toEqual([true, true]);

		background = 0;
		await timers.fire();
		expect(said, "restarted").toContain("restart: the install moved");
		expect(waits, "no longer, as the restart is asked").toEqual([
			true,
			true,
			false,
		]);
	});

	// Wakes let through while it stops would be refused, not left for the next host.
	it("says it waits for a gap no longer once the host begins stopping", async () => {
		let stopping = false;
		const timers = manualTimers();
		const waits: boolean[] = [];
		const { facts: given } = facts({
			background: () => 1,
			stopping: () => stopping,
			waitsForGap: (waiting) => waits.push(waiting),
		});
		restartWhenSettled(given, { after: timers.after, ceilingMs: 0 });
		await timers.fire();
		stopping = true;
		await timers.fire();
		expect(waits).toEqual([true, false]);
	});

	it("reports a throw saying it waits for a gap, and looks again", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			background: () => 1,
			waitsForGap: () => {
				throw new Error("unwoken");
			},
		});
		restartWhenSettled(given, { after: timers.after, ceilingMs: 0 });
		await timers.fire();
		expect(said, "reported").toContain("report: Error: unwoken");
		expect(timers.pending(), "the next look is set").toHaveLength(1);
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
		expect(timers.pending()).toHaveLength(1);
	});

	it("looks no more once stopped", async () => {
		const timers = manualTimers();
		const { facts: given } = facts();
		const stop = restartWhenSettled(given, { after: timers.after });
		stop();
		expect(timers.pending()).toEqual([]);
	});

	// The background host on 18 November: councils held its restart past
	// half its heap for hours, and at 01:15 V8 aborted it out of memory,
	// ending every turn and every council anyway.
	it("restarts at the first moment no turn runs once its heap is pressed, whatever background work or screens hold", async () => {
		let busy = true;
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => "its heap is pressed",
			held: () => [{ state: busy ? "busy" : "idle", since: lately }],
			background: () => 1,
			holding: () => ["s1: j1 review: council"],
			resting: () => false,
			pressure: () => "pressed",
		});
		given.restart = async (why, under) => {
			said.push(`restart under ${under.rule}: ${why}`);
		};
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(
			said.filter((line) => !line.startsWith("report:")),
			"never mid-turn",
		).toEqual([]);
		expect(timers.pending()[0]?.ms, "it looks for a gap each second").toBe(
			1000,
		);

		busy = false;
		await timers.fire(() => said.length > 1);
		expect(said).toEqual([
			"report: Heap short of room: restarting at the first moment no conversation has a turn, whatever background work or screens hold; 1 running now",
			"expect true",
			"restart under heap: its heap is pressed",
		]);
	});

	it("restarts at once, mid-turn, once its heap has nearly run out, naming the turns, screens and background work it ends", async () => {
		const timers = manualTimers();
		const rules: RestartRule[] = [];
		const { facts: given, said } = facts({
			differs: async () => "its heap has nearly run out",
			held: () => [
				{ state: "busy", since: lately },
				{ state: "busy", since: lately },
				{ state: "idle", since: lately },
			],
			background: () => 1,
			holding: () => ["s1: j1 review: council"],
			resting: () => false,
			pressure: () => "urgent",
		});
		given.restart = async (why, under) => {
			said.push(`restart: ${why}`);
			rules.push(under);
		};
		restartWhenSettled(given, { after: timers.after });
		await timers.fire(() => said.length > 1);
		expect(said).toEqual([
			"expect true",
			"restart: its heap has nearly run out",
		]);
		expect(rules).toEqual([
			{
				rule: "heap",
				pressure: "urgent",
				ending: ["s1: j1 review: council"],
				turns: 2,
				screens: true,
			},
		]);
	});

	it("goes back to waiting for background work once a pressed heap has room again", async () => {
		let pressure: "pressed" | undefined = "pressed";
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "busy", since: lately }],
			background: () => 1,
			pressure: () => pressure,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		expect(timers.pending()[0]?.ms, "pressed, a look a second").toBe(1000);

		pressure = undefined;
		await timers.fire();
		await timers.fire();
		expect(timers.pending()[0]?.ms, "with room, a look a minute").toBe(60);
		expect(said.filter((line) => !line.startsWith("report:"))).toEqual([]);
	});

	// 20 November 15:22: pressed, the background host waited 52 min for a
	// moment with no turn, as wakes kept starting turns, until its heap
	// ran to three-quarters and the restart ended 57 turns.
	it("drains the host while a pressed heap waits on a turn, once, and lifts it only once nothing is left to restart for", async () => {
		// Not yet pressed at the first look, so the ceiling starts counting.
		let pressure: "pressed" | undefined;
		let differs: string | undefined = "its heap is short";
		let clock = NOW;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const waits: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => differs,
			held: () => [{ state: "busy", since: lately }],
			pressure: () => pressure,
			drain: (on) => drains.push(on),
			waitsForGap: (waiting) => waits.push(waiting),
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		// Drained a second after the ceiling started counting, so it stands
		// short of its own ceiling once the host's is passed.
		clock += 1000;
		pressure = "pressed";
		await timers.fire();
		await timers.fire();
		expect(drains, "drained once, while the turn runs").toEqual([true]);
		expect(said).toEqual([
			"report: Heap short of room: restarting at the first moment no conversation has a turn, whatever background work or screens hold; 1 running now",
			"report: Heap short of room: the host drains, so each conversation parks as its turn ends and wakes wait for the next host",
		]);

		// Its own parks took it under three-fifths, but past half the host
		// still means to restart for its heap.
		pressure = undefined;
		differs = "its heap is past half";
		clock += SETTLE_CEILING_MS - 1000;
		await timers.fire();
		await timers.fire();
		expect(drains, "kept while the heap is past half").toEqual([true]);
		expect(
			waits.every((waiting) => !waiting),
			"no held wake let through past the ceiling while it stands",
		).toBe(true);

		// Asked about once a minute while only the drain keeps it pressed.
		differs = undefined;
		await timers.fire();
		expect(drains, "not asked again within the minute").toEqual([true]);
		clock += 60;
		await timers.fire();
		expect(drains, "lifted once nothing differs").toEqual([true, false]);
		expect(said.slice(2)).toEqual([
			"report: Nothing left to restart for: the drain the heap started lifts, and parked conversations wake as asked",
		]);

		pressure = "pressed";
		differs = "its heap is short";
		await timers.fire();
		await timers.fire();
		expect(drains, "drained again, pressed again").toEqual([true, false, true]);
	});

	// One turn that never ends would otherwise hold every parked
	// conversation and its wakes for as long as it runs.
	it("lifts the heap's drain a ceiling on with a turn still running, and drains again pressed again", async () => {
		let pressure: "pressed" | undefined = "pressed";
		const pastHalf = true;
		let clock = NOW;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "busy", since: lately }],
			pressure: () => pressure,
			heapRestarts: () => pastHalf,
			drain: (on) => drains.push(on),
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		expect(drains, "drained while the turn runs").toEqual([true]);

		// Its parks took it under three-fifths, and the turn runs on.
		pressure = undefined;
		clock += SETTLE_CEILING_MS;
		await timers.fire();
		await timers.fire();
		expect(drains, "lifted at its ceiling").toEqual([true, false]);
		expect(said).toContain(
			"report: A turn kept the heap's drain standing past its ceiling: the drain the heap started lifts, and parked conversations wake as asked",
		);

		// Waiting on turns alone let wakes grow the heap to three-quarters.
		pressure = "pressed";
		await timers.fire();
		await timers.fire();
		expect(drains, "drained again, pressed again").toEqual([true, false, true]);

		// The second drain has a ceiling of its own.
		pressure = undefined;
		clock += SETTLE_CEILING_MS - 1;
		await timers.fire();
		await timers.fire();
		expect(drains, "not lifted short of it").toEqual([true, false, true]);
		clock += 1;
		await timers.fire();
		await timers.fire();
		expect(drains, "lifted at it").toEqual([true, false, true, false]);
	});

	it("keeps the drain past its ceiling when the turn running began after it", async () => {
		let pressure: "pressed" | undefined = "pressed";
		let turns: readonly Held[] = [{ state: "busy", since: lately }];
		let clock = NOW;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => "its heap is short",
			held: () => turns,
			pressure: () => pressure,
			heapRestarts: () => true,
			drain: (on) => drains.push(on),
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();

		pressure = undefined;
		clock += SETTLE_CEILING_MS;
		turns = [{ state: "busy", since: new Date(clock - 1_000).toISOString() }];
		await timers.fire();
		await timers.fire();

		expect(drains, "a fresh turn lifts nothing").toEqual([true]);
		expect(said.filter((line) => line.includes("past its"))).toEqual([
			"report: Heap short of room past its drain's ceiling: turns begun since the drain keep it standing, so held wakes wait until the host restarts or its heap has room again",
		]);
	});

	it("keeps the drain a heap still pressed past its ceiling stands, and says so hourly", async () => {
		let clock = NOW;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => "its heap is short",
			held: () => [{ sessionId: "a", state: "busy", since: lately }],
			pressure: () => "pressed",
			heapRestarts: () => true,
			drain: (on) => drains.push(on),
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();

		clock += SETTLE_CEILING_MS;
		await timers.fire();
		await timers.fire();

		expect(drains, "still drains").toEqual([true]);
		const past = () => said.filter((line) => line.includes("past its"));
		expect(past()).toEqual([
			`report: Heap short of room past its drain's ceiling: a (busy since ${lately}) runs on from before the drain, so held wakes wait until the host restarts or its heap has room again`,
		]);

		clock += HELD_SAY_MS - 1;
		await timers.fire();
		await timers.fire();
		expect(past(), "not again within the hour").toHaveLength(1);
		clock += 1;
		await timers.fire();
		await timers.fire();
		expect(past(), "again an hour on").toHaveLength(2);
	});

	it("keeps the drain past its ceiling while a call, not a turn, holds the restart", async () => {
		let pressure: "pressed" | undefined = "pressed";
		let turns: readonly Held[] = [{ state: "busy", since: lately }];
		let clock = NOW;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => "its heap is short",
			held: () => turns,
			pressure: () => pressure,
			heapRestarts: () => true,
			drain: (on) => drains.push(on),
			quiet: async () => "a call is on",
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		expect(drains).toEqual([true]);

		// The turns ended as it drained; its parks took it under three-fifths.
		turns = [{ state: "idle", since: lately }];
		pressure = undefined;
		clock += SETTLE_CEILING_MS;
		await timers.fire();
		await timers.fire();

		expect(drains, "no turn holds it, so it stands").toEqual([true]);

		// Pressed again, with the call still on and no turn: still no blame.
		pressure = "pressed";
		await timers.fire();
		await timers.fire();
		expect(drains).toEqual([true]);
		expect(
			said.some((line) => line.includes("past its")),
			"no turn blamed",
		).toBe(false);
	});

	it("lifts the heap's drain once the heap is under half, and waits on another difference under the ordinary rules", async () => {
		let pressure: "pressed" | undefined = "pressed";
		let pastHalf = true;
		let state: Held["state"] = "busy";
		let differs = "its heap is short";
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => differs,
			held: () => [{ state, since: lately }],
			background: () => 1,
			holding: () => ["s1: j1 review: council"],
			pressure: () => pressure,
			heapRestarts: () => pastHalf,
			drain: (on) => drains.push(on),
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		expect(drains, "drained while the turn runs").toEqual([true]);

		// Its parks took it under half, and the install moved meanwhile.
		pressure = undefined;
		pastHalf = false;
		state = "idle";
		differs = "the install moved";
		await timers.fire();
		await timers.fire();
		expect(drains, "lifted").toEqual([true, false]);
		expect(
			said.filter((line) => line.startsWith("restart:")),
			"no restart ends the council",
		).toEqual([]);
		expect(said).toContain(
			"report: The heap is under half its limit again: the drain the heap started lifts, and parked conversations wake as asked",
		);
	});

	it("says it drains when a drain took before it threw, and says it waits again once pressed after a lift", async () => {
		let differs: string | undefined = "its heap is short";
		let hostDrains = false;
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => differs,
			held: () => [{ state: "busy", since: lately }],
			pressure: () => (differs === undefined ? undefined : "pressed"),
			drain: (on) => {
				hostDrains = on;
				if (on) throw new Error("drain half done");
			},
			draining: () => hostDrains,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		const waitsLine =
			"report: Heap short of room: restarting at the first moment no conversation has a turn, whatever background work or screens hold; 1 running now";
		expect(said).toEqual([
			waitsLine,
			"report: Error: drain half done",
			"report: Heap short of room: the host drains, so each conversation parks as its turn ends and wakes wait for the next host",
		]);

		// Lifted, and pressed again at the very next look.
		differs = undefined;
		await timers.fire();
		differs = "its heap is short";
		await timers.fire();
		expect(
			said.filter((line) => line === waitsLine),
			"said again, pressed again",
		).toHaveLength(2);
	});

	it("restarts with the drain still on once the turns end, after a call holding it ends", async () => {
		let state: Held["state"] = "busy";
		let call: string | undefined = "a call is on";
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => "its heap is short",
			held: () => [{ state, since: lately }],
			pressure: () => "pressed",
			drain: (on) => drains.push(on),
			quiet: async () => call,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		state = "idle";
		await timers.fire();
		expect(said, "held for the call").toContain(
			"report: Restart held while a call is on",
		);
		expect(drains, "the drain stays through the call").toEqual([true]);

		call = undefined;
		await timers.fire(() => said.includes("restart: its heap is short"));
		expect(drains, "never lifted before the restart").toEqual([true]);
	});

	it("leaves a drain asked for by hand to whoever asked, and drains again after a lift by hand", async () => {
		let differs: string | undefined = "its heap is short";
		let hostDrains = true;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given } = facts({
			differs: async () => differs,
			held: () => [{ state: "busy", since: lately }],
			pressure: () => (differs === undefined ? undefined : "pressed"),
			drain: (on) => {
				drains.push(on);
				hostDrains = on;
			},
			draining: () => hostDrains,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		await timers.fire();
		differs = undefined;
		await timers.fire();
		expect(
			drains,
			"a drain standing by hand, neither taken nor lifted",
		).toEqual([]);

		hostDrains = false;
		differs = "its heap is short";
		await timers.fire();
		// Lifted by hand while the heap is still pressed.
		hostDrains = false;
		await timers.fire();
		expect(drains, "drained, then again after the lift").toEqual([true, true]);
	});

	it("takes a drain by hand after the heap's was lifted by hand for its asker's, not a short heap's", async () => {
		let pressure: "pressed" | undefined = "pressed";
		let state: Held["state"] = "busy";
		let hostDrains = false;
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => "the install moved",
			held: () => [{ state, since: lately }],
			background: () => 1,
			pressure: () => pressure,
			drain: (on) => {
				hostDrains = on;
			},
			draining: () => hostDrains,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		expect(hostDrains, "the heap's drain").toBe(true);

		// Lifted by hand as the heap has room, then drained by hand again.
		hostDrains = false;
		pressure = undefined;
		state = "idle";
		await timers.fire();
		hostDrains = true;
		await timers.fire();
		await timers.fire();
		expect(
			said.filter((line) => line.startsWith("restart:")),
			"no heap restart ends the background work",
		).toEqual([]);
	});

	it("leaves the heap's drain lifted by hand as it is once nothing differs", async () => {
		let differs: string | undefined = "its heap is short";
		let hostDrains = false;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given, said } = facts({
			differs: async () => differs,
			held: () => [{ state: "busy", since: lately }],
			pressure: () => (differs === undefined ? undefined : "pressed"),
			drain: (on) => {
				drains.push(on);
				hostDrains = on;
			},
			draining: () => hostDrains,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		expect(drains, "the heap's drain").toEqual([true]);

		// Lifted by hand just as the heap has room again.
		hostDrains = false;
		differs = undefined;
		await timers.fire();
		await timers.fire();
		expect(drains, "nothing lifted twice").toEqual([true]);
		expect(
			said.some((line) => line.includes("Nothing left to restart for")),
			"no lift said that never happened",
		).toBe(false);
	});

	it("starts no drain for a heap with no turn to wait on, or one that has nearly run out", async () => {
		for (const [pressure, state] of [
			["pressed", "idle"],
			["urgent", "busy"],
		] as const) {
			const timers = manualTimers();
			const drains: boolean[] = [];
			const { facts: given, said } = facts({
				differs: async () => "its heap is short",
				held: () => [{ state, since: lately }],
				pressure: () => pressure,
				drain: (on) => drains.push(on),
			});
			restartWhenSettled(given, { after: timers.after });
			await timers.fire(() => said.length > 1);
			expect(drains, `${pressure} with the turn ${state}`).toEqual([]);
			expect(said, `${pressure} restarts at once`).toEqual([
				"expect true",
				"restart: its heap is short",
			]);
		}
	});

	it("reports a drain that throws, and goes on looking", async () => {
		let differs: string | undefined = "its heap is short";
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => differs,
			held: () => [{ state: "busy", since: lately }],
			pressure: () => (differs === undefined ? undefined : "pressed"),
			drain: () => {
				throw new Error("This host can't drain");
			},
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		await timers.fire();
		await timers.fire();
		expect(
			said.filter((line) => line.includes("can't drain")),
			"said once, not each second",
		).toEqual(["report: Error: This host can't drain"]);
		expect(
			said.some((line) => line.includes("the host drains")),
			"no drain said to have started",
		).toBe(false);
		expect(timers.pending()[0]?.ms, "a look a second").toBe(1000);

		// Pressed again after room, it tries again and says so again.
		differs = undefined;
		await timers.fire();
		differs = "its heap is short";
		await timers.fire();
		expect(
			said.filter((line) => line.includes("can't drain")),
			"said again once pressed again",
		).toHaveLength(2);
	});

	it("lifts a drain that took before it threw, once nothing differs", async () => {
		let differs: string | undefined = "its heap is short";
		let hostDrains = false;
		const timers = manualTimers();
		const drains: boolean[] = [];
		const { facts: given } = facts({
			differs: async () => differs,
			held: () => [{ state: "busy", since: lately }],
			pressure: () => (differs === undefined ? undefined : "pressed"),
			drain: (on) => {
				drains.push(on);
				hostDrains = on;
				if (on) throw new Error("Drained, then failed to say so");
			},
			draining: () => hostDrains,
		});
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		differs = undefined;
		await timers.fire();
		expect(drains, "the drain that took is lifted").toEqual([true, false]);
	});

	// Waking parked conversations grows a heap already short of room.
	it("lets no held wake through while its heap is short, past the ceiling or not", async () => {
		let clock = NOW;
		const timers = manualTimers();
		const waits: boolean[] = [];
		const { facts: given } = facts({
			held: () => [{ state: "busy", since: lately }],
			background: () => 1,
			pressure: () => "pressed",
			waitsForGap: (waiting) => waits.push(waiting),
			now: () => clock,
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		clock += SETTLE_CEILING_MS;
		await timers.fire();
		await timers.fire();
		expect(waits).toEqual([false, false, false]);
	});

	// The 18 November host: sixty conversations, one always mid-turn.
	it("waits as long as a turn always runs while pressed, saying so once, then restarts at once as the heap nearly runs out", async () => {
		let pressure: "pressed" | "urgent" = "pressed";
		const timers = manualTimers();
		const sixty: Held[] = Array.from({ length: 60 }, (_, at) => ({
			state: at === 0 ? "busy" : "idle",
			since: lately,
		}));
		const { facts: given, said } = facts({
			differs: async () => "its heap is short",
			held: () => sixty,
			background: () => 3,
			pressure: () => pressure,
		});
		restartWhenSettled(given, { after: timers.after });
		for (let look = 0; look < 5; look++) await timers.fire();
		expect(said).toEqual([
			"report: Heap short of room: restarting at the first moment no conversation has a turn, whatever background work or screens hold; 1 running now",
		]);

		pressure = "urgent";
		await timers.fire(() => said.length > 2);
		expect(said.slice(1)).toEqual([
			"expect true",
			"restart: its heap is short",
		]);
	});

	// 19 November 16:38:58: the attended host restarted itself mid-call,
	// as its install moved, and every window on it went with it.
	it("waits while a call is on or a meeting is near, saying why once, and restarts once it is clear", async () => {
		const timers = manualTimers();
		let why: string | undefined = "a call is on";
		const { facts: given, said } = facts({ quiet: async () => why });
		restartWhenSettled(given, { after: timers.after, lookMs: 60 });
		await timers.fire();
		await timers.fire();
		expect(said).toEqual(["report: Restart held while a call is on"]);
		expect(timers.pending().map(({ ms }) => ms)).toEqual([60]);

		why = undefined;
		await timers.fire(() => said.length > 2);
		expect(said.slice(1)).toEqual([
			"expect true",
			"restart: the install moved",
		]);
	});

	it("looks a minute apart while a call holds a restart past the ceiling, not a second", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			quiet: async () => "a meeting is near",
		});
		restartWhenSettled(given, {
			after: timers.after,
			lookMs: 60,
			ceilingMs: 0,
		});
		await timers.fire();
		await timers.fire();
		expect(timers.pending().map(({ ms }) => ms)).toEqual([60]);
		expect(said).toEqual(["report: Restart held while a meeting is near"]);
	});

	it("holds a pressed heap's restart for a call, but not one whose heap has nearly run out", async () => {
		let pressure: "pressed" | "urgent" = "pressed";
		const timers = manualTimers();
		const { facts: given, said } = facts({
			differs: async () => "its heap is short",
			pressure: () => pressure,
			quiet: async () => "a call is on",
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual(["report: Restart held while a call is on"]);

		pressure = "urgent";
		await timers.fire(() => said.length > 2);
		expect(said.slice(1)).toEqual([
			"expect true",
			"restart: its heap is short",
		]);
	});

	it("holds the restart when it can't tell whether a call is on", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			quiet: async () => {
				throw new Error("no answer");
			},
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual([
			"report: Restart held while it can't tell whether a call is on or a meeting is near: Error: no answer",
		]);
	});

	it("asks for no restart when a turn began while the probes answered", async () => {
		const timers = manualTimers();
		let busy = false;
		const { facts: given, said } = facts({
			held: () => [
				busy
					? { state: "busy", since: lately }
					: { state: "idle", since: long },
			],
			quiet: async () => {
				busy = true;
				return undefined;
			},
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual([]);
	});

	it("asks for no restart when it was stopped while the probes answered", async () => {
		const timers = manualTimers();
		let answered = false;
		let stop: () => void = () => undefined;
		const { facts: given, said } = facts({
			quiet: async () => {
				stop();
				answered = true;
				return undefined;
			},
		});
		stop = restartWhenSettled(given, { after: timers.after });
		await timers.fire(() => answered);
		await vi.waitFor(() => {
			if (timers.pending().length > 0) throw new Error("It looks again");
		});
		expect(said).toEqual([]);
	});

	it("lets held wakes through no longer once a call holds a restart that waited for a gap", async () => {
		const timers = manualTimers();
		const waits: boolean[] = [];
		let busy = true;
		const { facts: given } = facts({
			held: () => [
				busy
					? { state: "busy", since: lately }
					: { state: "idle", since: long },
			],
			quiet: async () => (busy ? undefined : "a call is on"),
			waitsForGap: (waiting) => waits.push(waiting),
		});
		restartWhenSettled(given, {
			after: timers.after,
			lookMs: 60,
			gapLookMs: 1,
			ceilingMs: 0,
		});
		await timers.fire();
		await timers.fire();
		expect(waits.at(-1), "a turn runs, so it waits for a gap").toBe(true);

		busy = false;
		await timers.fire();
		expect(waits.at(-1), "a call holds it, so it waits for none").toBe(false);
		expect(timers.pending().map(({ ms }) => ms)).toEqual([60]);
	});

	it("says again each hour that a call still holds the restart", async () => {
		const timers = manualTimers();
		let clock = NOW;
		const { facts: given, said } = facts({
			now: () => clock,
			quiet: async () => "a call is on",
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		await timers.fire();
		expect(said).toEqual(["report: Restart held while a call is on"]);

		clock += HELD_SAY_MS;
		await timers.fire();
		expect(said).toEqual([
			"report: Restart held while a call is on",
			"report: Restart held while a call is on",
		]);
	});

	it("asks for no restart for its heap once the host has begun stopping", async () => {
		const timers = manualTimers();
		const { facts: given, said } = facts({
			stopping: () => true,
			pressure: () => "urgent",
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said).toEqual([]);
	});
});

describe("followWhatStarts", () => {
	const unit = "pi-host-work-attended.service";
	let dir: string;
	let install: string;
	let cgroup: string;
	let unitFile: string;
	// The probes this machine's own unit names, kept from every case.
	const waitsOn = process.env.PI_HOST_RESTART_WAITS_ON;
	beforeEach(async () => {
		delete process.env.PI_HOST_RESTART_WAITS_ON;
		dir = await realpath(await mkdtemp(join(tmpdir(), "h1-restart-")));
		install = join(dir, "install");
		cgroup = join(dir, "cgroup");
		unitFile = join(dir, unit);
		await writeFile(cgroup, `0::/user.slice/app.slice/${unit}\n`);
		await writeFile(unitFile, "[Service]\n");
		for (const [version, body] of [
			["one", "export const a = 1;\n"],
			["same", "export const a = 1;\n"],
			["two", "export const a = 2;\n"],
		] as const) {
			const root = join(install, "versions", version);
			await mkdir(join(root, "scripts"), { recursive: true });
			await mkdir(join(root, "host"), { recursive: true });
			await writeFile(
				join(root, "scripts", "pi-host.ts"),
				'import "../host/a.ts";\n',
			);
			await writeFile(join(root, "host", "a.ts"), body);
		}
		await symlink(join(install, "versions", "one"), join(install, "current"));
	});
	afterEach(async () => {
		if (waitsOn === undefined) delete process.env.PI_HOST_RESTART_WAITS_ON;
		else process.env.PI_HOST_RESTART_WAITS_ON = waitsOn;
		await rm(dir, { recursive: true, force: true });
	});

	// systemd as the test has it: this process the unit's main one, its
	// file the one named, read since it last changed.
	function systemd(main = 7): {
		systemctl: Systemctl;
		calls: string[][];
	} {
		const calls: string[][] = [];
		return {
			calls,
			systemctl: async (args) => {
				calls.push([...args]);
				if (args.includes("--property=MainPID")) return `MainPID=${main}\n`;
				if (args[0] === "show")
					return `NeedDaemonReload=no\nFragmentPath=${unitFile}\nDropInPaths=\n`;
				return "";
			},
		};
	}

	// A heap far under V8's limit, unless a test says otherwise.
	const small = () => ({ usedBytes: MB, limitBytes: 4144 * MB });

	// What the host holds, unless a test says otherwise: one conversation
	// long idle, no background work and every screen at rest.
	async function follow(
		systemctl: Systemctl,
		report = vi.fn(),
		heap = small,
		holds: {
			held?: () => readonly Held[];
			background?: () => number;
			holding?: () => readonly string[];
			resting?: () => boolean;
			quiet?: () => Promise<string | undefined>;
			drain?: (on: boolean) => void;
			draining?: () => boolean;
		} = {},
	) {
		const timers = manualTimers();
		const serving = {
			held: holds.held ?? (() => [{ state: "idle" as const, since: long }]),
			restartComing: vi.fn(),
			stopping: () => false,
		};
		const stop = await followWhatStarts({
			serving,
			background: holds.background ?? (() => 0),
			...(holds.holding ? { holding: holds.holding } : {}),
			resting: holds.resting ?? (() => true),
			...(holds.quiet ? { quiet: holds.quiet } : {}),
			...(holds.drain ? { drain: holds.drain } : {}),
			...(holds.draining ? { draining: holds.draining } : {}),
			report,
			root: join(install, "versions", "one"),
			systemctl,
			cgroupFile: cgroup,
			pid: 7,
			heap,
			timing: { after: timers.after, settledMs: 0 },
		});
		return { timers, serving, stop, report };
	}

	async function moveTo(version: string) {
		const next = join(install, "next");
		await symlink(join(install, "versions", version), next);
		await rename(next, join(install, "current"));
	}

	it("restarts its own unit once the install changes the host's own code", async () => {
		const { systemctl, calls } = systemd();
		const { timers, serving, report } = await follow(systemctl);
		await timers.fire();
		expect(serving.restartComing).not.toHaveBeenCalled();

		await moveTo("two");
		await timers.fire(() => calls.at(-1)?.[1] === "restart");

		expect(serving.restartComing).toHaveBeenCalledExactlyOnceWith(true);
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
		expect(String(report.mock.calls[0]?.[0])).toContain(
			"the install's two changes the host's own code",
		);
	});

	it("restarts for a moved install only once no call is on", async () => {
		const { systemctl, calls } = systemd();
		let why: string | undefined = "a call is on";
		const { timers, report } = await follow(systemctl, vi.fn(), small, {
			quiet: async () => why,
		});
		await moveTo("two");
		await timers.fire();
		expect(
			calls.some((call) => call[1] === "restart"),
			"none mid-call",
		).toBe(false);
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restart held while a call is on",
		);

		why = undefined;
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
	});

	it("waits on the probes its unit names when given none", async () => {
		process.env.PI_HOST_RESTART_WAITS_ON = JSON.stringify([
			{ while: "a call is on", run: ["/bin/sh", "-c", "exit 0"] },
		]);
		const { systemctl, calls } = systemd();
		const { timers, report } = await follow(systemctl);
		await moveTo("two");
		await timers.fire();
		expect(
			calls.some((call) => call[1] === "restart"),
			"none while the unit's probe says a call is on",
		).toBe(false);
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restart held while a call is on",
		);
	});

	it("says in its journal when it restarts under the ceiling rather than once all settled", async () => {
		const { systemctl, calls } = systemd();
		const timers = manualTimers();
		const report = vi.fn();
		await followWhatStarts({
			serving: {
				// It changed just now, by the clock the host reads.
				held: () => [
					{ state: "idle" as const, since: new Date().toISOString() },
				],
				restartComing: vi.fn(),
				stopping: () => false,
			},
			background: () => 0,
			resting: () => true,
			report,
			root: join(install, "versions", "one"),
			systemctl,
			cgroupFile: cgroup,
			pid: 7,
			timing: { after: timers.after, ceilingMs: 0 },
		});
		await moveTo("two");
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restarting at a moment no conversation had a turn or a job, having waited 0 min for every one to settle 2 min at once, as the install's two changes the host's own code",
		);
	});

	it("drains the host it follows while a pressed heap waits on a turn, unless it drains already", async () => {
		const { systemctl } = systemd();
		const drains: boolean[] = [];
		// A drain asked by hand stands until the host says it doesn't.
		let byHand = true;
		const { timers } = await follow(
			systemctl,
			vi.fn(),
			() => ({ usedBytes: 2600 * MB, limitBytes: 4144 * MB }),
			{
				held: () => [{ state: "busy", since: long }],
				drain: (on) => drains.push(on),
				draining: () => byHand || drains.at(-1) === true,
			},
		);
		await timers.fire();
		expect(drains, "none over a drain the host says stands").toEqual([]);

		byHand = false;
		await timers.fire();
		await timers.fire();
		expect(drains, "the host's own drain, started once").toEqual([true]);
	});

	it("restarts once its heap passes half of what V8 allows, the install unmoved", async () => {
		const { systemctl, calls } = systemd();
		const { timers, serving, report } = await follow(
			systemctl,
			vi.fn(),
			() => ({ usedBytes: 2073 * MB, limitBytes: 4144 * MB }),
		);
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(serving.restartComing).toHaveBeenCalledExactlyOnceWith(true);
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restarting once every conversation settled, as its heap holds 2073 of the 4144 MB V8 allows, past half",
		);
	});

	it("still waits for background work past half of what V8 allows, short of three-fifths", async () => {
		const { systemctl } = systemd();
		const { timers, serving } = await follow(
			systemctl,
			vi.fn(),
			() => ({ usedBytes: 2486 * MB, limitBytes: 4144 * MB }),
			{ background: () => 1 },
		);
		await timers.fire();
		expect(serving.restartComing).not.toHaveBeenCalled();
	});

	it("restarts past three-fifths of what V8 allows at a moment no turn runs, ending the screens and background work it names", async () => {
		const { systemctl, calls } = systemd();
		const { timers, serving, report } = await follow(
			systemctl,
			vi.fn(),
			() => ({ usedBytes: 2487 * MB, limitBytes: 4144 * MB }),
			{
				held: () => [{ state: "idle", since: lately }],
				background: () => 1,
				holding: () => ["s1: j1 review: council"],
				resting: () => false,
			},
		);
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(serving.restartComing).toHaveBeenCalledExactlyOnceWith(true);
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restarting at a moment no conversation had a turn, before its heap runs out, ending a screen in use; s1: j1 review: council, as its heap holds 2487 of the 4144 MB V8 allows, past three-fifths",
		);
	});

	it("restarts at once, mid-turn, past three-quarters of what V8 allows, saying the turn it ends", async () => {
		const { systemctl, calls } = systemd();
		const { timers, report } = await follow(
			systemctl,
			vi.fn(),
			() => ({ usedBytes: 3109 * MB, limitBytes: 4144 * MB }),
			{
				held: () => [{ state: "busy", since: lately }],
				background: () => 0,
			},
		);
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restarting at once, turns and all, before its heap runs out, ending 1 turn mid-answer, as its heap holds 3109 of the 4144 MB V8 allows, past three-quarters",
		);
	});

	it("says both its heap and the install's move when it restarts for its heap with the install moved", async () => {
		const { systemctl, calls } = systemd();
		const { timers, report } = await follow(
			systemctl,
			vi.fn(),
			() => ({ usedBytes: 3109 * MB, limitBytes: 4144 * MB }),
			{ held: () => [{ state: "busy", since: lately }] },
		);
		await moveTo("two");
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(String(report.mock.calls[0]?.[0])).toBe(
			"Restarting at once, turns and all, before its heap runs out, ending 1 turn mid-answer, as its heap holds 3109 of the 4144 MB V8 allows, past three-quarters, and the install's two changes the host's own code",
		);
	});

	it("stays while its heap holds half of what V8 allows or less", async () => {
		const { systemctl } = systemd();
		const { timers, serving } = await follow(systemctl, vi.fn(), () => ({
			usedBytes: 2072 * MB,
			limitBytes: 4144 * MB,
		}));
		await timers.fire();
		expect(serving.restartComing).not.toHaveBeenCalled();
	});

	it("stays when the install moves to the same host code", async () => {
		const { systemctl } = systemd();
		const { timers, serving } = await follow(systemctl);
		await moveTo("same");
		await timers.fire();
		expect(serving.restartComing).not.toHaveBeenCalled();
	});

	it("restarts once systemd has read a new unit file", async () => {
		const { systemctl, calls } = systemd();
		const { timers, serving } = await follow(systemctl);
		const next = join(dir, "next.service");
		await writeFile(next, "[Service]\n");
		await rename(unitFile, join(dir, "old.service"));
		await symlink(next, unitFile);
		await timers.fire(() => calls.at(-1)?.[1] === "restart");
		expect(serving.restartComing).toHaveBeenCalledExactlyOnceWith(true);
		expect(calls.at(-1)).toEqual(["--no-block", "restart", unit]);
	});

	it("follows nothing where it isn't the unit's main process", async () => {
		const { systemctl, calls } = systemd(8);
		const { timers } = await follow(systemctl);
		expect(timers.pending()).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("follows nothing outside a unit", async () => {
		await writeFile(cgroup, "0::/user.slice/session-2.scope\n");
		const { systemctl, calls } = systemd();
		const { timers } = await follow(systemctl);
		expect(timers.pending()).toEqual([]);
		expect(calls).toEqual([]);
	});
});
