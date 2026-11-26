/**
 * Whether the machine has memory to start a council: on Linux the
 * kernel's memory `full avg60` under 10, or no reading at all; on a Mac
 * the queue's own rule over the swap history the machine shares.
 */

import { describe, expect, it } from "vitest";
import {
	type DatedFacts,
	MAC_READING_SERVES_MS,
	type MacSources,
	macRoundRoom,
	memoryShort,
	sharedReading,
	UNREAD_WAIT_MS,
} from "../../../../lib/core/review/ask/memory-room.ts";
import {
	type DarwinFacts,
	darwinFactsNow,
	historyInMemory,
	SWAPPING_MS,
} from "../../../../lib/internal/priority/room-darwin.ts";

/** A pressure file as Linux writes it, with `full avg60` at `avg60`. */
const pressure = (avg60: string) => async () =>
	[
		"some avg10=23.19 avg60=16.16 avg300=17.63 total=56294624829",
		`full avg10=8.79 avg60=${avg60} avg300=6.91 total=29952573033`,
		"",
	].join("\n");

describe("whether the machine has memory for a round", () => {
	it("has room while full avg60 is under 10, whatever some reads", async () => {
		expect(await memoryShort(pressure("9.99"))).toBeUndefined();
	});

	it("is short at 10 and past it, saying the reading", async () => {
		expect(await memoryShort(pressure("10.00"))).toBe(
			"memory full avg60 was 10, at or past 10",
		);
		expect(await memoryShort(pressure("14.2"))).toContain("14.2");
	});

	it("has room where no pressure is kept, as on a Mac", async () => {
		expect(
			await memoryShort(async () => {
				throw Object.assign(new Error("no such file"), { code: "ENOENT" });
			}),
		).toBeUndefined();
	});

	it("has room when the reading holds no full line", async () => {
		expect(
			await memoryShort(async () => "some avg10=1 avg60=50 avg300=1 total=1\n"),
		).toBeUndefined();
	});
});

/** A Mac with room: normal pressure, half its memory available. */
const roomy: DarwinFacts = {
	memsize: 64 * 1024 ** 3,
	cores: 12,
	availablePercent: 50,
	pressureLevel: 1,
	load: 2,
	swapouts: 1000,
	guests: 0,
};

/** A Mac whose figures are `read`, at a time the test moves. */
function mac(read: () => DarwinFacts | Error): MacSources & {
	advance(ms: number): void;
} {
	let now = 1_000_000;
	return {
		reading: (): DatedFacts => {
			const facts = read();
			if (facts instanceof Error) throw facts;
			return { at: now, facts };
		},
		clock: () => now,
		history: historyInMemory(),
		advance: (ms) => {
			now += ms;
		},
	};
}

describe("whether a Mac has memory for a round", () => {
	it("waits for a reading a minute old, then starts while nothing says short", async () => {
		const sources = mac(() => roomy);
		const room = macRoundRoom(sources);
		expect(await room.short()).toContain("a reading a minute old");
		sources.advance(SWAPPING_MS);
		expect(await room.short()).toBeUndefined();
		expect(room.startedUnread()).toBeUndefined();
	});

	it("is short at warning pressure, saying the level", async () => {
		const room = macRoundRoom(mac(() => ({ ...roomy, pressureLevel: 2 })));
		expect(await room.short()).toContain("pressure level is 2");
	});

	it("is short while it swapped out within the last minute", async () => {
		let swapouts = 1000;
		const sources = mac(() => ({ ...roomy, swapouts }));
		const room = macRoundRoom(sources);
		await room.short();
		sources.advance(SWAPPING_MS / 2);
		swapouts = 1500;
		expect(await room.short()).toBe(
			"it swapped out 500 pages in the last 30 s",
		);
	});

	it("is short under the queue's share of memory available", async () => {
		const room = macRoundRoom(mac(() => ({ ...roomy, availablePercent: 34 })));
		expect(await room.short()).toContain("34% of its memory is available");
	});

	it("reads the baseline another session left in the shared history", async () => {
		const sources = mac(() => roomy);
		sources.history.save([{ at: 1_000_000 - SWAPPING_MS, swapouts: 1000 }]);
		expect(await macRoundRoom(sources).short()).toBeUndefined();
	});

	it("waits on figures it can't read for at most 15 minutes, then starts and says why", async () => {
		const sources = mac(() => new Error("sysctl timed out"));
		const room = macRoundRoom(sources);
		expect(await room.short()).toBe(
			"this Mac's memory can't be read (sysctl timed out)",
		);
		sources.advance(UNREAD_WAIT_MS - 1);
		expect(await room.short()).toBeDefined();
		sources.advance(1);
		expect(await room.short()).toBeUndefined();
		expect(room.startedUnread()).toBe(
			"It started though this Mac's memory couldn't be read for 15 minutes (sysctl timed out).",
		);
	});

	it("counts a figure that isn't a number as unread", async () => {
		const room = macRoundRoom(
			mac(() => ({ ...roomy, pressureLevel: Number.NaN })),
		);
		expect(await room.short()).toBe(
			"this Mac's memory can't be read (no figure for pressureLevel)",
		);
	});

	it("starts the wait on unread figures again once a reading comes", async () => {
		let broken = true;
		const sources = mac(() => (broken ? new Error("gone") : roomy));
		sources.history.save([{ at: 1_000_000 - SWAPPING_MS, swapouts: 1000 }]);
		const room = macRoundRoom(sources);
		await room.short();
		sources.advance(UNREAD_WAIT_MS - 1);
		broken = false;
		await room.short();
		broken = true;
		sources.advance(1);
		expect(await room.short()).toContain("can't be read");
	});
});

describe("one reading of a Mac shared by its rounds", () => {
	it("serves one reading for ten seconds, dated when it was read", () => {
		let now = 0;
		let reads = 0;
		const reading = sharedReading(
			() => {
				reads += 1;
				now += 5;
				return roomy;
			},
			() => now,
		);
		expect(reading().at).toBe(5);
		now += MAC_READING_SERVES_MS - 10;
		expect(reading().at).toBe(5);
		now += 10;
		expect(reading().at).toBe(MAC_READING_SERVES_MS + 10);
		expect(reads).toBe(2);
	});

	it("keeps no reading that threw, so the next look asks again", () => {
		let fail = true;
		const reading = sharedReading(
			() => {
				if (fail) throw new Error("vm_stat timed out");
				return roomy;
			},
			() => 0,
		);
		expect(() => reading()).toThrow("vm_stat timed out");
		fail = false;
		expect(reading().facts).toBe(roomy);
	});
});

describe.runIf(process.platform === "darwin")("this Mac's own figures", () => {
	it("reads every figure the room needs", () => {
		const facts = darwinFactsNow();
		for (const figure of [
			facts.availablePercent,
			facts.pressureLevel,
			facts.swapouts,
		]) {
			expect(Number.isFinite(figure)).toBe(true);
		}
	});
});
