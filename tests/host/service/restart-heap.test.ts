/** When a host restarts itself for its heap, before V8 runs out. */
import { describe, expect, it } from "vitest";
import {
	GAP_LOOK_MS,
	HELD_SAY_MS,
	type Held,
	LOOK_MS,
	RESTART_DUE_MS,
	restartWhenSettled,
	SETTLE_CEILING_MS,
} from "../../../host/service/restart.ts";
import {
	facts,
	growingHeap,
	lately,
	manualTimers,
	NOW,
	restartsSaid,
} from "./restart-fakes.ts";

describe("restartWhenSettled, for its heap", () => {
	// The background host on 16 November: its heap passed half its limit
	// before 09:12, and review rounds and shell jobs held its restart every
	// hour until V8 ran out at 20:44 and ended them all anyway.
	//
	// Each case's heap reads low at the host's first look, as a fresh
	// host's does, and grows after.

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

		expect(
			said,
			"nothing restarted mid-turn, and what held it said once",
		).toEqual([
			"report: Its heap holds 75% of what V8 allows, past what the gap tier restarts for, held by 1 running turn",
		]);
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

	it("up to 80% of its heap limit, still never restarts mid-turn or with a screen in use, saying what holds it", async () => {
		for (const [holder, overrides] of [
			[
				"1 running turn",
				{ held: () => [{ state: "busy" as const, since: lately }] },
			],
			["a screen in use", { resting: () => false }],
		] as const) {
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
			expect(
				said.filter((line) => line.includes("held by")),
				"what holds it, said once",
			).toEqual([
				`report: Its heap holds 80% of what V8 allows, past what the gap tier restarts for, held by ${holder}`,
			]);
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
		expect(
			said.filter((line) => line.startsWith("report:")),
			"nothing said of a first look at 60%, which leaves the gap tier room, only why 74% doesn't restart",
		).toEqual([
			"report: Its heap holds 74% of what V8 allows, too little grown for a heap restart: the gap tier weighs growth from 60% and the urgent one from 60%",
		]);

		heap.growTo(0.76);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said.filter((line) => line.startsWith("restart"))).toEqual([
			'restart under {"rule":"heap","share":0.76,"turns":0,"jobs":1}: its heap holds 76% of what V8 allows',
		]);
	});

	// A turn or a screen can hold the gap tier for hours, and the journal
	// should say so before V8 runs out.
	it("says once an hour what holds a heap the gap tier would restart for", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		let clock = NOW;
		let resting = true;
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "busy", since: lately }],
			background: () => 1,
			resting: () => resting,
			heapShare: heap.heapShare,
			now: () => clock,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.75);
		for (let look = 0; look < 5; look++) {
			clock += GAP_LOOK_MS;
			await timers.fire();
		}
		resting = false;
		clock += HELD_SAY_MS;
		await timers.fire();
		expect(said.filter((line) => line.startsWith("restart"))).toEqual([]);
		expect(said.filter((line) => line.startsWith("report:"))).toEqual([
			"report: Its heap holds 75% of what V8 allows, past what the gap tier restarts for, held by 1 running turn",
			"report: Its heap holds 75% of what V8 allows, past what the gap tier restarts for, held by 1 running turn and a screen in use",
		]);
	});

	it("backs off a refusal from a second again once a restart is queued", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		let refuse = true;
		const { facts: given } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "idle", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		given.restart = async () => {
			if (refuse) throw new Error("systemctl timed out");
		};
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.75);
		await timers.fire();
		await timers.fire();
		expect(timers.pending()[0]?.ms, "backed off twice").toBe(2 * GAP_LOOK_MS);
		refuse = false;
		await timers.fire();
		expect(timers.pending()[0]?.ms, "a restart queued").toBe(RESTART_DUE_MS);
		refuse = true;
		await timers.fire();
		expect(
			timers.pending()[0]?.ms,
			"refused again after systemd dropped it",
		).toBe(GAP_LOOK_MS);
	});

	it("backs off a refusal from a second again once the heap has stopped pressing", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		const { facts: given } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "idle", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		given.restart = async () => {
			throw new Error("systemctl timed out");
		};
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.75);
		await timers.fire();
		await timers.fire();
		expect(timers.pending()[0]?.ms, "backed off twice").toBe(2 * GAP_LOOK_MS);
		heap.growTo(0.3);
		await timers.fire();
		expect(timers.pending()[0]?.ms, "a look, unpressed").toBe(LOOK_MS);
		heap.growTo(0.75);
		await timers.fire();
		expect(timers.pending()[0]?.ms, "refused again, pressed anew").toBe(
			GAP_LOOK_MS,
		);
	});

	it("weighs growth from the lowest its heap fell to since its first look", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.84);
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () => [{ state: "idle", since: lately }],
			background: () => 1,
			heapShare: heap.heapShare,
		});
		restartsSaid(given, said);
		restartWhenSettled(given, { after: timers.after });
		await timers.fire();
		heap.growTo(0.3);
		await timers.fire();
		heap.growTo(0.71);
		await timers.fire(() => said.some((line) => line.startsWith("restart")));
		expect(said.filter((line) => line.startsWith("restart"))).toEqual([
			'restart under {"rule":"heap","share":0.71,"turns":0,"jobs":1}: its heap holds 71% of what V8 allows',
		]);
	});

	// Conversations taking turns would otherwise put each refusal back to
	// a second, and systemctl would be spawned at every gap for hours.
	it("under the gap tier, keeps backing off a lasting refusal across looks that find a turn running", async () => {
		const timers = manualTimers();
		const heap = growingHeap(0.3);
		let state: Held["state"] = "idle";
		const { facts: given } = facts({
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
		heap.growTo(0.75);
		const waits: number[] = [];
		for (let refused = 0; refused < 3; refused++) {
			state = "idle";
			await timers.fire();
			waits.push(timers.pending()[0]?.ms ?? 0);
			state = "busy";
			await timers.fire();
		}
		expect(waits, "each wait after a refusal").toEqual([
			GAP_LOOK_MS,
			2 * GAP_LOOK_MS,
			4 * GAP_LOOK_MS,
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
			"report: Its heap held 86% of what V8 allows once V8 had caught up after its first look, so until it falls only the urgent tier restarts it for its heap, once past 80% and grown 5% from its floor",
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
	])(
		"under $tier, tries a refused restart again after 1, 2 and 4 s, up to a look",
		async ({ share, state }) => {
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
		},
	);

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
});
