/** What a host's heap tiers weigh growth from, through parks, wakes and V8's readings. */
import { describe, expect, it } from "vitest";
import { asleep, growingHeap } from "./restart-fakes.ts";

describe("restartWhenSettled, for what its heap has grown from", () => {
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
		let readings = 0;
		const host = asleep(growingHeap(0.75), {
			heapReadings: () => readings,
		});
		host.wake("a", "b");
		await host.look(0.75);
		// Caught up, so they park under marks their wake puts back.
		readings += 2;
		await host.look(0.75);
		host.park("a", "b");
		readings += 2;
		await host.look(0.4);
		host.wake("a", "b");
		for (let look = 0; look < 30; look++) await host.look(0.4);
		readings += 2;
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
		let readings = 1;
		const host = asleep(growingHeap(0.55), {
			heapReadings: () => readings,
		});
		host.wake("a", "b");
		await host.look(0.55);
		for (let look = 0; look < 5; look++) {
			if (look < 2) readings++;
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
		let readings = 1;
		const host = asleep(growingHeap(0.55), {
			heapReadings: () => readings,
		});
		host.wake("a", "b");
		await host.look(0.55);
		readings = 3;
		await host.look(0.55);
		await host.look(0.75);
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 75% /),
		]);
	});

	it("sees a climb once V8 has collected twice after a wake loaded", async () => {
		let readings = 0;
		const host = asleep(growingHeap(0.5), {
			heapReadings: () => readings,
		});
		host.wake("a", "b");
		await host.look(0.5);
		readings = 2;
		await host.look(0.5);
		host.park("a", "b");
		readings = 3;
		await host.look(0.3);
		host.wake("a", "b");
		for (let look = 0; look < 12; look++) await host.look(0.3);
		readings = 4;
		await host.look(0.3);
		readings = 5;
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
		let readings = 0;
		const host = asleep(growingHeap(0.85), {
			heapReadings: () => readings,
		});
		host.wake("a", "b");
		await host.look(0.85);
		host.park("a");
		readings = 1;
		await host.look(0.4);
		readings = 2;
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
		let readings = 0;
		const host = asleep(growingHeap(0.75), {
			heapReadings: () => readings,
		});
		host.wake("x");
		await host.look(0.75);
		host.park("x");
		readings = 1;
		await host.look(0.4);
		host.wake("x");
		readings = 2;
		await host.look(0.4);
		for (let look = 0; look < 12; look++) await host.look(0.4);
		readings = 3;
		await host.look(0.4);
		readings = 4;
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	it("weighs no growth from a park and wake between two looks before V8 caught up", async () => {
		let readings = 0;
		const host = asleep(growingHeap(0.75), {
			heapReadings: () => readings,
		});
		host.wake("x");
		await host.look(0.75);
		host.park("x");
		host.wake("x");
		readings = 1;
		await host.look(0.4);
		readings = 2;
		await host.look(0.4);
		for (let look = 0; look < 12; look++) await host.look(0.4);
		readings = 3;
		await host.look(0.4);
		readings = 4;
		for (let look = 0; look < 3; look++) await host.look(0.75);
		expect(
			host.restarts(),
			"nothing restarted for what the wake refilled",
		).toEqual([]);
	});

	// An idle host may not collect for long after a wake, and the reading
	// that shows the refill is the one that ends the window.
	it("lets the gap tier's mark rise until V8 has collected twice after waking one parked at its first look", async () => {
		let readings = 0;
		const host = asleep(growingHeap(0.4), {
			heapReadings: () => readings,
		});
		host.park("a");
		await host.look(0.4);
		readings = 2;
		await host.look(0.4);
		host.wake("a");
		for (let look = 0; look < 30; look++) await host.look(0.4);
		readings = 3;
		await host.look(0.4);
		readings = 4;
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
		expect(
			host.restarts().join(),
			"a marked wake loads nothing the marks missed",
		).not.toContain('"loading"');
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

	// The background host's conversations park and wake all day, and were
	// each wake to hold the marks up afresh, room a close freed would never
	// count, and the urgent tier would wait past where a park failed.
	it("lets the marks fall between wakes that keep coming", async () => {
		const host = asleep(growingHeap(0.84));
		host.wake("a", "b", "c");
		await host.look(0.84);
		host.close("b");
		for (let look = 0; look < 40; look++) {
			if (look % 5 === 0) host.park("c");
			if (look % 5 === 1) host.wake("c");
			await host.look(look < 20 ? 0.3 : 0.72);
			if (host.restarts().length > 0) break;
		}
		expect(host.restarts(), "a heap restart at the gap").toEqual([
			expect.stringMatching(/"rule":"heap".*: its heap holds 72% /),
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
});
