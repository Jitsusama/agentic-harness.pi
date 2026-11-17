/** When a host restarts itself for its heap, before V8 runs out. */
import { describe, expect, it } from "vitest";
import {
	GAP_LOOK_MS,
	HELD_SAY_MS,
	type Held,
	LOOK_MS,
	RESTART_DUE_MS,
	type RestartFacts,
	restartWhenSettled,
	SETTLE_CEILING_MS,
} from "../../../host/service/restart.ts";
import { facts, lately, manualTimers, NOW } from "./restart-fakes.ts";

describe("restartWhenSettled, for its heap", () => {
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

	// Its resumed conversations park and free their heap, and what fills it
	// again would otherwise climb to where a park failed before acting.
	// Its parked conversations come back when woken, so the heap a park
	// frees isn't room, and counting it so would restart at every wake.
	// A parked conversation leaves what the host runs and stays on its
	// roster, so the fakes list it by parked() and leave it out of held().
	// Each wake begins it anew, as the session host numbers it.
	function asleep(
		heap: ReturnType<typeof growingHeap>,
		more: Partial<RestartFacts> = {},
	) {
		const awake = new Map<string, number>();
		const parked = new Set<string>();
		let begun = 0;
		let clock = NOW;
		const { facts: given, said } = facts({
			differs: async () => "its heap is past half",
			held: () =>
				[...awake].map(([id, at]) => ({
					id,
					begun: at,
					state: "idle" as const,
					since: lately,
				})),
			parked: () => [...parked],
			background: () => 1,
			heapShare: heap.heapShare,
			now: () => clock,
			...more,
		});
		restartsSaid(given, said);
		const timers = manualTimers();
		restartWhenSettled(given, { after: timers.after });
		return {
			wake(...ids: string[]) {
				for (const id of ids) {
					parked.delete(id);
					awake.set(id, ++begun);
				}
			},
			park(...ids: string[]) {
				for (const id of ids) {
					awake.delete(id);
					parked.add(id);
				}
			},
			close(...ids: string[]) {
				for (const id of ids) {
					awake.delete(id);
					parked.delete(id);
				}
			},
			// A look a minute on, at the share given.
			async look(share: number) {
				heap.growTo(share);
				clock += LOOK_MS;
				await timers.fire();
			},
			restarts: () => said.filter((line) => line.startsWith("restart")),
			reports: () => said.filter((line) => line.startsWith("report:")),
		};
	}

	it("weighs no growth from the heap a park frees, since a wake fills it again", async () => {
		const host = asleep(growingHeap(0.75));
		host.wake("a", "b");
		for (let cycle = 0; cycle < 3; cycle++) {
			await host.look(0.75);
			host.park("a", "b");
			await host.look(0.4);
			host.wake("a", "b");
		}
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what a wake refills",
		).toEqual([]);
	});

	// The reading is what V8 kept at its last full collections, and an idle
	// host may not collect for a long while after a wake.
	it("lets no reading from before a wake lower the mark, however long V8 waits to collect", async () => {
		let collections = 0;
		const host = asleep(growingHeap(0.75), {
			heapCollections: () => collections,
		});
		host.wake("a", "b");
		await host.look(0.75);
		host.park("a", "b");
		collections += 2;
		await host.look(0.4);
		host.wake("a", "b");
		for (let look = 0; look < 30; look++) await host.look(0.4);
		collections += 2;
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	it("weighs no growth from waking what was parked at its first look", async () => {
		const host = asleep(growingHeap(0.4));
		host.park("a", "b");
		await host.look(0.4);
		host.wake("a", "b");
		// V8's reading follows the refill only as it collects, so it climbs.
		for (const share of [0.45, 0.6, 0.75]) await host.look(share);
		for (let look = 0; look < 40; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	it("weighs no growth from a park after a parked conversation closed", async () => {
		const host = asleep(growingHeap(0.72));
		host.wake("a", "b");
		host.park("c");
		await host.look(0.72);
		host.close("c");
		await host.look(0.72);
		host.park("b");
		await host.look(0.5);
		host.wake("b");
		for (let look = 0; look < 3; look++) await host.look(0.72);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	it("weighs no growth from one conversation parking as another wakes", async () => {
		const host = asleep(growingHeap(0.72));
		host.wake("a", "b");
		await host.look(0.72);
		host.park("b");
		await host.look(0.65);
		host.wake("b");
		host.park("a");
		await host.look(0.4);
		host.wake("a");
		for (let look = 0; look < 3; look++) await host.look(0.72);
		expect(
			host.restarts(),
			"nothing restarted for what the wakes refilled",
		).toEqual([]);
	});

	it("sees a climb while conversations stay parked after a high first look", async () => {
		const host = asleep(growingHeap(0.84));
		host.wake("a", "b", "c");
		await host.look(0.84);
		host.park("a", "b");
		await host.look(0.3);
		await host.look(0.72);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 72% /),
		]);
	});

	// A host's conversations park after half an hour idle, and a message
	// or a viewer can wake one again within the minute between two looks.
	it("weighs no growth from a park and wake that both fall between two looks", async () => {
		const host = asleep(growingHeap(0.75));
		host.wake("a", "b");
		await host.look(0.75);
		await host.look(0.75);
		host.park("a", "b");
		host.wake("a", "b");
		// The park's collection, before the refill shows.
		await host.look(0.4);
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	// A host starts once its last conversation has resumed, but the reading
	// may be from collections that ran before they had all loaded.
	it("weighs no growth from its resumed conversations until V8 has collected after its first look", async () => {
		let collections = 1;
		const host = asleep(growingHeap(0.55), {
			heapCollections: () => collections,
		});
		host.wake("a", "b");
		await host.look(0.55);
		for (let look = 0; look < 5; look++) {
			if (look < 2) collections++;
			await host.look(0.75);
		}
		expect(
			host.restarts(),
			"nothing restarted for what had resumed before its first look",
		).toEqual([]);
		expect(host.reports(), "said of the look V8 had caught up at").toEqual([
			"report: Its heap held 75% of what V8 allows once V8 had caught up after its first look, so until it falls only the urgent tier restarts it for its heap, once past 80% and grown 5% from its floor",
		]);
	});

	it("sees a climb once V8 has collected twice after its first look", async () => {
		let collections = 1;
		const host = asleep(growingHeap(0.55), {
			heapCollections: () => collections,
		});
		host.wake("a", "b");
		await host.look(0.55);
		collections = 3;
		await host.look(0.55);
		await host.look(0.75);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 75% /),
		]);
	});

	it("sees a climb once V8 has collected twice after a wake loaded", async () => {
		let collections = 0;
		const host = asleep(growingHeap(0.5), {
			heapCollections: () => collections,
		});
		host.wake("a", "b");
		await host.look(0.5);
		collections = 2;
		await host.look(0.5);
		host.park("a", "b");
		collections = 3;
		await host.look(0.3);
		host.wake("a", "b");
		for (let look = 0; look < 12; look++) await host.look(0.3);
		collections = 4;
		await host.look(0.3);
		collections = 5;
		await host.look(0.5);
		await host.look(0.5);
		expect(host.restarts(), "nothing restarted for the refill").toEqual([]);
		await host.look(0.72);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 72% /),
		]);
	});

	// A reading before V8 has caught up after the first look is no mark,
	// so a park then keeps none for its wake to put back.
	it("puts back no mark from before V8 caught up when one parked then wakes", async () => {
		let collections = 0;
		const host = asleep(growingHeap(0.85), {
			heapCollections: () => collections,
		});
		host.wake("a", "b");
		await host.look(0.85);
		host.park("a");
		collections = 1;
		await host.look(0.4);
		collections = 2;
		await host.look(0.4);
		host.wake("a");
		for (const share of [0.6, 0.8, 0.88]) await host.look(share);
		expect(host.restarts(), "a heap restart, past 80%").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 88% /),
		]);
	});

	// Its marks are set at the look V8 catches up at, which must not lose
	// a wake before it, or the refill counts as growth.
	it("weighs no growth from a park and wake before V8 caught up after its first look", async () => {
		let collections = 0;
		const host = asleep(growingHeap(0.75), {
			heapCollections: () => collections,
		});
		host.wake("x");
		await host.look(0.75);
		host.park("x");
		collections = 1;
		await host.look(0.4);
		host.wake("x");
		collections = 2;
		await host.look(0.4);
		for (let look = 0; look < 12; look++) await host.look(0.4);
		collections = 3;
		await host.look(0.4);
		collections = 4;
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	it("weighs no growth from a park and wake between two looks before V8 caught up", async () => {
		let collections = 0;
		const host = asleep(growingHeap(0.75), {
			heapCollections: () => collections,
		});
		host.wake("x");
		await host.look(0.75);
		host.park("x");
		host.wake("x");
		collections = 1;
		await host.look(0.4);
		collections = 2;
		await host.look(0.4);
		for (let look = 0; look < 12; look++) await host.look(0.4);
		collections = 3;
		await host.look(0.4);
		collections = 4;
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	// An idle host may not collect for long after a wake, and the reading
	// that shows the refill is the one that ends the window.
	it("lets the gap tier's mark rise until V8 has collected twice after waking one parked at its first look", async () => {
		let collections = 0;
		const host = asleep(growingHeap(0.4), {
			heapCollections: () => collections,
		});
		host.park("a");
		await host.look(0.4);
		collections = 2;
		await host.look(0.4);
		host.wake("a");
		for (let look = 0; look < 30; look++) await host.look(0.4);
		collections = 3;
		await host.look(0.4);
		collections = 4;
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	// Conversations park and wake all day, so were each wake to hold the
	// gap tier's mark rising, it would never see a climb.
	it("lets no wake under a mark hold the gap tier's mark rising", async () => {
		const host = asleep(growingHeap(0.4));
		host.wake("b");
		host.park("a");
		await host.look(0.4);
		host.wake("a");
		await host.look(0.5);
		for (let look = 0; look < 5; look++) await host.look(0.55);
		host.park("b");
		await host.look(0.55);
		host.wake("b");
		for (let look = 0; look < 5; look++) await host.look(0.55);
		await host.look(0.72);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 72% /),
		]);
	});

	// One parked at the first look parked under no mark, so the gap tier's
	// mark follows its refill up; the urgent tier's must not, or a climb
	// beside it, as others keep waking, runs into V8's limit unseen. So a
	// refill alone past 80% and 5% over the floor restarts it too: that
	// near the 87% where a park failed, a restart is the safer end, and
	// its line says a wake was loading.
	it("restarts at once past 80%, even for a refill of one parked at its first look, as others keep waking", async () => {
		const host = asleep(growingHeap(0.4));
		host.wake("b");
		host.park("a", "c");
		await host.look(0.4);
		host.wake("a");
		// Until the first restart, since one systemd never ran is asked again.
		for (const share of [0.5, 0.6, 0.7, 0.8, 0.86, 0.92]) {
			await host.look(share);
			if (host.restarts().length > 0) break;
			host.wake("c");
			await host.look(share);
			if (host.restarts().length > 0) break;
			host.park("c");
		}
		expect(host.restarts(), "a heap restart, once past 80%").toEqual([
			expect.stringMatching(
				/"rule":"heap","share":0.86,"turns":0,"jobs":1,"loading":true}: its heap holds 86% /,
			),
		]);
	});

	it("sees a climb once the readings have caught up with waking one parked at its first look", async () => {
		const host = asleep(growingHeap(0.4));
		host.park("a");
		await host.look(0.4);
		host.wake("a");
		for (let look = 0; look < 14; look++) await host.look(0.55);
		await host.look(0.75);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 75% /),
		]);
	});

	it("sees a climb past what a wake put back", async () => {
		const host = asleep(growingHeap(0.5));
		host.wake("a", "b");
		await host.look(0.5);
		host.park("b");
		await host.look(0.3);
		host.wake("b");
		await host.look(0.5);
		await host.look(0.8);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 80% /),
		]);
	});

	// A look asks what would start, which may outlast a collection that
	// moves the reading; what it weighed is what it restarts on.
	it("restarts on no reading its mark never weighed", async () => {
		const heap = growingHeap(0.45);
		const host = asleep(heap, {
			differs: async () => {
				heap.growTo(0.76);
				return "its heap is past half";
			},
		});
		host.park("a");
		await host.look(0.45);
		host.wake("a");
		for (let look = 0; look < 3; look++) await host.look(0.45);
		expect(
			host.restarts(),
			"nothing restarted on a reading taken mid-look",
		).toEqual([]);
	});

	// After an out-of-memory end, the journal should show why no tier acted.
	it("says once an hour why a heap past 70% doesn't restart it", async () => {
		const host = asleep(growingHeap(0.4));
		host.wake("b");
		host.park("a");
		await host.look(0.4);
		host.wake("a");
		for (const share of [0.6, 0.75, 0.76, 0.77]) await host.look(share);
		const first =
			"report: Its heap holds 75% of what V8 allows, too little grown for a heap restart: the gap tier weighs growth from 75% and the urgent one from 40%, while a wake's conversations load";
		const heapSaid = () =>
			host.reports().filter((line) => line.startsWith("report: Its heap"));
		expect(heapSaid(), "said at 75%").toEqual([first]);
		// Said at the third look, so the hour is up at the 63rd.
		for (let look = 6; look < 63; look++) await host.look(0.77);
		expect(heapSaid(), "not again within the hour").toEqual([first]);
		await host.look(0.77);
		expect(heapSaid(), "again once the hour is up").toEqual([
			first,
			"report: Its heap holds 77% of what V8 allows, too little grown for a heap restart: the gap tier weighs growth from 77% and the urgent one from 40%",
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

	it("counts what a close frees as room", async () => {
		const host = asleep(growingHeap(0.84));
		host.wake("a", "b");
		await host.look(0.84);
		host.close("b");
		await host.look(0.3);
		await host.look(0.72);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 72% /),
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
