/**
 * Whether the machine has memory to start a council: on Linux the
 * kernel's memory `full avg60` under 5 and enough available, a figure
 * it can't read holding nothing back; on a Mac the queue's own rule over
 * the swap history the machine shares.
 */

import { describe, expect, it } from "vitest";
import {
	LEAST_AVAILABLE_BYTES,
	type LinuxSources,
	MAC_READING_SERVES_MS,
	type MacSources,
	macFiguresFrom,
	macFiguresNow,
	macRoundRoom,
	memoryShort,
	sharedReading,
	UNJUDGED_WAIT_MS,
} from "../../../../lib/core/review/ask/memory-room.ts";
import {
	historyInMemory,
	type MemoryFigures,
	SWAPPING_MS,
} from "../../../../lib/internal/priority/room-darwin.ts";

/** A pressure file as Linux writes it, with `full avg60` at `avg60`. */
const pressureAt = (avg60: string) =>
	[
		"some avg10=23.19 avg60=16.16 avg300=17.63 total=56294624829",
		`full avg10=8.79 avg60=${avg60} avg300=6.91 total=29952573033`,
		"",
	].join("\n");

/** A meminfo file as Linux writes it, in kB. */
const meminfoOf = (totalKb: number, availableKb: number) =>
	[
		`MemTotal:       ${totalKb} kB`,
		"MemFree:         1000000 kB",
		`MemAvailable:   ${availableKb} kB`,
		"",
	].join("\n");

const GB_IN_KB = 1e9 / 1024;

/** A machine of `totalGb` with `availableGb` free and `avg60` in its pressure. */
function linux(avg60: string, availableGb = 30, totalGb = 64): LinuxSources {
	return {
		pressure: async () => pressureAt(avg60),
		meminfo: async () =>
			meminfoOf(
				Math.round(totalGb * GB_IN_KB),
				Math.round(availableGb * GB_IN_KB),
			),
	};
}

const missing = async (): Promise<string> => {
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

describe("whether a Linux machine has memory for a round", () => {
	it("has room while full avg60 is under 5 and 16 GB is available", async () => {
		expect(await memoryShort(linux("4.99", 16.1))).toBeUndefined();
	});

	it("is short at 5 and past it, saying the reading", async () => {
		expect(await memoryShort(linux("5.00"))).toBe(
			"memory full avg60 was 5, at or past 5",
		);
		expect(await memoryShort(linux("8.23"))).toContain("8.23");
	});

	it("is short under 16 GB available, saying how much was", async () => {
		expect(await memoryShort(linux("0.37", 15))).toBe(
			"15.0 GB of memory was available, under 16.0 GB",
		);
		expect(LEAST_AVAILABLE_BYTES).toBe(16e9);
	});

	it("wants only a quarter of a machine too small for 16 GB", async () => {
		expect(await memoryShort(linux("0.1", 8.1, 32))).toBeUndefined();
		expect(await memoryShort(linux("0.1", 7.9, 32))).toContain("under 8.0 GB");
	});

	it("judges by what is available where no pressure is kept", async () => {
		expect(
			await memoryShort({ ...linux("0"), pressure: missing }),
		).toBeUndefined();
		expect(
			await memoryShort({ ...linux("0", 2), pressure: missing }),
		).toContain("2.0 GB");
	});

	it("holds nothing back on a figure it can't read", async () => {
		expect(
			await memoryShort({ pressure: missing, meminfo: missing }),
		).toBeUndefined();
		expect(
			await memoryShort({
				pressure: async () => "some avg10=1 avg60=50 avg300=1 total=1\n",
				meminfo: async () => "MemTotal: 1 kB\n",
			}),
		).toBeUndefined();
	});
});

/** A Mac with room: normal pressure, half its memory available. */
const roomy: MemoryFigures = {
	availablePercent: 50,
	pressureLevel: 1,
	swapouts: 1000,
};

/** A Mac whose figures are `read`, at a time the test moves. */
function mac(read: () => MemoryFigures | Error): MacSources & {
	advance(ms: number): void;
	readonly history: ReturnType<typeof historyInMemory>;
} {
	let now = 1_000_000;
	const clock = () => now;
	const history = historyInMemory();
	return {
		reading: sharedReading(
			async () => {
				const figures = read();
				if (figures instanceof Error) throw figures;
				return figures;
			},
			clock,
			history,
		),
		clock,
		unjudged: { since: undefined },
		history,
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
		expect(room.startedUnjudged()).toBeUndefined();
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

	it("holds a round as long as it reads short, with no cap", async () => {
		const sources = mac(() => ({ ...roomy, availablePercent: 34 }));
		const room = macRoundRoom(sources);
		expect(await room.short()).toContain("34% of its memory is available");
		sources.advance(UNJUDGED_WAIT_MS * 3);
		expect(await room.short()).toContain("34% of its memory is available");
		expect(room.startedUnjudged()).toBeUndefined();
	});

	it("reads the baseline another session left in the shared history", async () => {
		const sources = mac(() => roomy);
		sources.history.save([{ at: 1_000_000 - SWAPPING_MS, swapouts: 1000 }]);
		expect(await macRoundRoom(sources).short()).toBeUndefined();
	});

	it("waits on figures it can't read for at most ten minutes, then starts and says why", async () => {
		const sources = mac(() => new Error("sysctl timed out"));
		const room = macRoundRoom(sources);
		expect(await room.short()).toBe(
			"this Mac's memory can't be read (sysctl timed out)",
		);
		sources.advance(UNJUDGED_WAIT_MS - 1);
		expect(await room.short()).toBeDefined();
		sources.advance(1);
		expect(await room.short()).toBeUndefined();
		expect(room.startedUnjudged()).toBe(
			"It started though this Mac's room couldn't be judged for 10 minutes: this Mac's memory can't be read (sysctl timed out).",
		);
	});

	it("counts the wait for a baseline toward the same cap", async () => {
		// A history another writer keeps emptying never gives the swap rule
		// a reading a minute old to compare against.
		const sources = mac(() => roomy);
		const room = macRoundRoom(sources);
		await room.short();
		sources.history.save([]);
		sources.advance(UNJUDGED_WAIT_MS);
		sources.history.save([]);
		expect(await room.short()).toBeUndefined();
		expect(room.startedUnjudged()).toContain("a reading a minute old");
	});

	it("shares the wait between the rounds of a process", async () => {
		const sources = mac(() => new Error("gone"));
		await macRoundRoom(sources).short();
		sources.advance(UNJUDGED_WAIT_MS);
		const later = macRoundRoom(sources);
		expect(await later.short()).toBeUndefined();
		expect(later.startedUnjudged()).toContain("gone");
	});

	it("counts a swap count vm_stat didn't give as unread, not as none", async () => {
		const figures = macFiguresFrom(
			"kern.memorystatus_level: 50\nkern.memorystatus_vm_pressure_level: 1\n",
			"Pages free: 1.\n",
		);
		const room = macRoundRoom(mac(() => figures));
		expect(await room.short()).toBe(
			"this Mac's memory can't be read (no figure for swapouts)",
		);
	});

	it("reads the figures from sysctl's and vm_stat's answers", () => {
		expect(
			macFiguresFrom(
				"kern.memorystatus_level: 41\nkern.memorystatus_vm_pressure_level: 2\n",
				"Pageouts: 9.\nSwapouts:                     1234.\n",
			),
		).toEqual({ availablePercent: 41, pressureLevel: 2, swapouts: 1234 });
	});

	it("starts the wait again once a reading gives a verdict", async () => {
		let broken = true;
		const sources = mac(() => (broken ? new Error("gone") : roomy));
		sources.history.save([{ at: 1_000_000 - SWAPPING_MS, swapouts: 1000 }]);
		const room = macRoundRoom(sources);
		await room.short();
		sources.advance(UNJUDGED_WAIT_MS - MAC_READING_SERVES_MS);
		// The first baseline is too old by now to date a window, so the
		// verdict needs one a minute before this reading.
		sources.history.save([
			{ at: sources.clock() - SWAPPING_MS, swapouts: roomy.swapouts },
		]);
		broken = false;
		expect(await room.short()).toBeUndefined();
		broken = true;
		sources.advance(MAC_READING_SERVES_MS);
		expect(await room.short()).toContain("can't be read");
	});
});

describe("one reading of a Mac shared by its rounds", () => {
	it("serves one reading while it is fresh, dated when it was read", async () => {
		let now = 0;
		let reads = 0;
		const reading = sharedReading(
			async () => {
				reads += 1;
				now += 5;
				return roomy;
			},
			() => now,
			historyInMemory(),
		);
		expect((await reading()).at).toBe(5);
		now += MAC_READING_SERVES_MS - 10;
		expect((await reading()).at).toBe(5);
		now += 10;
		expect((await reading()).at).toBe(MAC_READING_SERVES_MS + 10);
		expect(reads).toBe(2);
	});

	it("asks once for rounds that look while a reading is under way", async () => {
		let reads = 0;
		const reading = sharedReading(
			async () => {
				reads += 1;
				return roomy;
			},
			() => 0,
			historyInMemory(),
		);
		await Promise.all([reading(), reading(), reading()]);
		expect(reads).toBe(1);
	});

	it("serves a failure as long as a reading, so a Mac that can't answer isn't asked at every look", async () => {
		let now = 0;
		let reads = 0;
		const reading = sharedReading(
			async () => {
				reads += 1;
				throw new Error("vm_stat timed out");
			},
			() => now,
			historyInMemory(),
		);
		await expect(reading()).rejects.toThrow("vm_stat timed out");
		await expect(reading()).rejects.toThrow("vm_stat timed out");
		expect(reads).toBe(1);
		now += MAC_READING_SERVES_MS;
		await expect(reading()).rejects.toThrow("vm_stat timed out");
		expect(reads).toBe(2);
	});

	it("adds each reading to the shared history", async () => {
		const history = historyInMemory();
		const reading = sharedReading(
			async () => roomy,
			() => 7,
			history,
		);
		expect((await reading()).seen).toEqual([{ at: 7, swapouts: 1000 }]);
		expect(history.load()).toEqual([{ at: 7, swapouts: 1000 }]);
	});
});

describe.runIf(process.platform === "darwin")("this Mac's own figures", () => {
	it("reads every figure the room needs", async () => {
		const figures = await macFiguresNow();
		expect(figures.availablePercent).toBeGreaterThanOrEqual(0);
		expect(figures.pressureLevel).toBeGreaterThanOrEqual(0);
		expect(figures.swapouts).toBeGreaterThanOrEqual(0);
	});
});
