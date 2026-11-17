/** When a host restarts itself: only once it would differ and all is settled. */
import { describe, expect, it } from "vitest";
import {
	GAP_LOOK_MS,
	HELD_SAY_MS,
	LOOK_MS,
	type Held,
	RESTART_DUE_MS,
	type RestartFacts,
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

	// The background host on 16 November: its heap passed half its limit
	// before 09:12, and review rounds and shell jobs held its restart every
	// hour until V8 ran out at 20:44 and ended them all anyway.
	//
	// Each case's heap reads low at the host's first look, as a fresh
	// host's does, and grows after.
	function growingHeap(first: number) {
		let share = first;
		return {
			heapShare: () => share,
			growTo: (next: number) => {
				share = next;
			},
		};
	}

	function restartsSaid(given: RestartFacts, said: string[]): void {
		given.restart = async (why, under) => {
			said.push(`restart under ${JSON.stringify(under)}: ${why}`);
		};
	}

	it("past 70% of its heap limit, grown since its first look, restarts at the first gap, background work or not, before the ceiling", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "idle", since: lately }],
			background: () => 2,
			heapShare: heap.heapShare,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		expect(said, "held at its first look, well under the limit").toEqual([]);

		heap.growTo(0.71);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said).toEqual([
			"expect true",
			'restart under {"rule":"heap","share":0.71,"turns":0,"jobs":2}: its heap holds 71% of what V8 allows',
		]);
	});

	it("past 70% of its heap limit with a turn running, looks for a gap each second and asks nothing more", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		let asked = 0;
		const { facts: given, said } = facts({
			differs: async () => {
				asked++;
				return "its heap is past half";
			},
			held: () => [{ state: "busy", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.75);
		for (let look = 0; look < 4; look++) await timers.fire();

		expect(said, "nothing restarted mid-turn").toEqual([]);
		expect(asked, "only the first look asked what it would start").toBe(1);
		expect(
			timers.pending().map(({ ms }) => ms),
			"the next look is a gap look",
		).toEqual([GAP_LOOK_MS]);
	});

	it("past 70% of its heap limit, restarts in a gap between turns long before the ceiling, background work held", async () => {
		const TURN_MS = 90_000;
		const GAP_MS = 5000;
		const CYCLE_MS = 2 * (TURN_MS + GAP_MS);
		let clock = NOW;
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
		const heap = growingHeap(0.3);
		const seen: Held[][] = [];
		const { facts: given, said } = facts({
			held,
			now: () => clock,
			background: () => 1,
			heapShare: heap.heapShare,
		});
		given.restart = async (_why, under) => {
			seen.push([...held()]);
			said.push(`restart under ${under.rule}`);
		};
		restartWhenSettled(given, { after: timers.after });
		clock += timers.pending()[0]?.ms ?? 0;
		await timers.fire();
		heap.growTo(0.75);
		const grewAt = clock;
		while (
			!said.some((line) => line.startsWith("restart")) &&
			clock < NOW + SETTLE_CEILING_MS
		) {
			clock += timers.pending()[0]?.ms ?? 0;
			await timers.fire();
		}

		expect(
			said.filter((line) => line.startsWith("restart")),
			"it restarted once, under the heap rule",
		).toEqual(["restart under heap"]);
		expect(clock - grewAt, "within one cycle of its turns").toBeLessThanOrEqual(
			CYCLE_MS,
		);
		expect(
			seen[0]?.map(({ state }) => state),
			"in a gap, with no conversation running",
		).toEqual(["idle", "idle"]);
	});

	it("up to 80% of its heap limit, still never restarts mid-turn or with a screen in use", async () => {
		for (const overrides of [
			{ held: () => [{ state: "busy" as const, since: lately }] },
			{ resting: () => false },
		]) {
			const timers = manualTimers();
			const heap = growingHeap(0.3);
			const { facts: given, said } = facts({
				background: () => 1,
				heapShare: heap.heapShare,
				...overrides,
			});
			restartWhenSettled(given, { after: timers.after });
			await timers.fire();
			heap.growTo(0.8);
			await timers.fire();
			await timers.fire();
			expect(
				said.filter((line) => !line.startsWith("report:")),
				"nothing restarted",
			).toEqual([]);
		}
	});

	it("past 80% of its heap limit, restarts mid-turn and with a screen in use, since running out ends it all", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "busy", since: lately }],
			background: () => 1,
			resting: () => false,
			heapShare: heap.heapShare,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.81);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said).toEqual([
			"expect true",
			'restart under {"rule":"heap","share":0.81,"turns":1,"jobs":1}: its heap holds 81% of what V8 allows',
		]);
	});

	it("at 70% of its heap limit or under, background work still holds it", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		const { facts: given, said } = facts({
			held: () => [{ state: "idle", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		restartWhenSettled(given, { after: timers.after, ceilingMs: 0 });
		await timers.fire();
		heap.growTo(0.7);
		await timers.fire();
		await timers.fire();
		expect(
			said.filter((line) => !line.startsWith("report:")),
			"nothing restarted",
		).toEqual([]);
	});

	// A host whose resumed conversations alone fill its heap would restart
	// for it at every first look, ending their work each time, and free
	// nothing a restart can free.
	it("at a gap, restarts for its heap only once it has grown 15% of the limit since its first look", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.6);
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "idle", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.74);
		await timers.fire();
		await timers.fire();
		expect(
			said.filter((line) => !line.startsWith("report:")),
			"nothing restarted, grown only 14%",
		).toEqual([]);

		heap.growTo(0.76);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said.filter((line) => line.startsWith("restart"))).toEqual([
			'restart under {"rule":"heap","share":0.76,"turns":0,"jobs":1}: its heap holds 76% of what V8 allows',
		]);
	});

	// A host resumed past 75% would otherwise restart at its every gap,
	// for conversations the next host resumes the same.
	it("with a first look past 65%, leaves the gap tier to the urgent one, however long it holds", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.76);
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "idle", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		for (let look = 0; look < 5; look++) await timers.fire();
		heap.growTo(0.8);
		for (let look = 0; look < 5; look++) await timers.fire();
		expect(
			said.filter((line) => line.startsWith("restart")),
			"nothing restarted at a gap, grown only 4%",
		).toEqual([]);

		heap.growTo(0.82);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said.filter((line) => line.startsWith("restart"))).toEqual([
			'restart under {"rule":"heap","share":0.82,"turns":0,"jobs":1}: its heap holds 82% of what V8 allows',
		]);
	});

	// Its next host would resume the same conversations and read the same,
	// so restarting would end their turns every five minutes for nothing.
	it("past 80% from its first look, restarts mid-turn only once grown 5% more, saying once what holds it", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.86);
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "busy", since: lately }],
			background: () => 1,
			resting: () => false,
			heapShare: heap.heapShare,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		for (let look = 0; look < 5; look++) await timers.fire();
		heap.growTo(0.9);
		for (let look = 0; look < 5; look++) await timers.fire();
		expect(said, "nothing restarted, and said once").toEqual([
			"report: Its heap already held 86% of what V8 allows at its first look, so only the urgent tier restarts it for its heap, once past 80% and grown 5% from there",
		]);

		heap.growTo(0.92);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said.filter((line) => line.startsWith("restart"))).toEqual([
			'restart under {"rule":"heap","share":0.92,"turns":1,"jobs":1}: its heap holds 92% of what V8 allows',
		]);
	});

	it("restarts for its heap without asking again what it would start", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		let asked = 0;
		const { facts: given, said } = facts({
			differs: async () => {
				asked++;
				return "its heap is past half";
			},
			held: () => [{ state: "idle", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.75);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said.filter((line) => line.startsWith("restart"))).toHaveLength(1);
		expect(asked, "only the first look asked").toBe(1);
	});

	// A refusal that lasts, the user manager unreachable or the unit
	// masked, would otherwise spawn systemctl and journal it every second.
	it.each([
		{ tier: "the gap tier", share: 0.75, state: "idle" as const },
		{ tier: "the urgent tier", share: 0.81, state: "busy" as const },
	])("under $tier, tries a refused restart again after 1, 2 and 4 s, up to a look", async ({
		share,
		state,
	}) => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state, since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		given.restart = async () => {
			throw new Error("systemctl timed out");
		};
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(share);
		const waits: number[] = [];
		for (let refused = 0; refused < 8; refused++) {
			await timers.fire();
			waits.push(timers.pending()[0]?.ms ?? 0);
		}
		expect(said).toContain("report: Error: systemctl timed out");
		expect(waits, "each wait after a refusal").toEqual([
			GAP_LOOK_MS,
			2 * GAP_LOOK_MS,
			4 * GAP_LOOK_MS,
			8 * GAP_LOOK_MS,
			16 * GAP_LOOK_MS,
			32 * GAP_LOOK_MS,
			LOOK_MS,
			LOOK_MS,
		]);
	});

	it("asks for no restart once the host has begun stopping, however full its heap", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		const { facts: given, said } = facts({
			stopping: () => true,
			held: () => [{ state: "busy", since: lately }],
			background: () => 1,
			resting: () => false,
			heapShare: heap.heapShare,
		});
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.95);
		await timers.fire();
		await timers.fire();
		expect(said, "nothing restarted").toEqual([]);
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
});
