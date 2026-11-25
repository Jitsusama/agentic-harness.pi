/**
 * Whether the machine has memory to start a council: on Linux the
 * kernel's memory `full avg60` under 10, or no reading at all; on a Mac
 * 35% free and no swap-out for a minute, read or refused.
 */

import { describe, expect, it } from "vitest";
import {
	type MacMemory,
	macMemoryShort,
	memoryShort,
	parseMacMemory,
	SWAP_STILL_MS,
	swapWatch,
} from "../../../../lib/core/review/ask/memory-room.ts";

/** A pressure file as Linux writes it, with `full avg60` at `avg60`. */
const pressure = (avg60: string) => async () =>
	[
		"some avg10=23.19 avg60=16.16 avg300=17.63 total=56294624829",
		`full avg10=8.79 avg60=${avg60} avg300=6.91 total=29952573033`,
		"",
	].join("\n");

describe("whether the machine has memory for a round", () => {
	it("has room while full avg60 is under 10, whatever some reads", async () => {
		expect(await memoryShort(pressure("9.99"), "linux")).toBeUndefined();
	});

	it("is short at 10 and past it, saying the reading", async () => {
		expect(await memoryShort(pressure("10.00"), "linux")).toBe(
			"memory full avg60 was 10, at or past 10",
		);
		expect(await memoryShort(pressure("14.2"), "linux")).toContain("14.2");
	});

	it("has room on a Linux that keeps no pressure, as an old kernel", async () => {
		expect(
			await memoryShort(async () => {
				throw Object.assign(new Error("no such file"), { code: "ENOENT" });
			}, "linux"),
		).toBeUndefined();
	});

	it("has room when the reading holds no full line", async () => {
		expect(
			await memoryShort(
				async () => "some avg10=1 avg60=50 avg300=1 total=1\n",
				"linux",
			),
		).toBeUndefined();
	});
});

/** A Mac reading `freePercent` free with `swapouts` pages swapped out. */
const mac =
	(freePercent: number, swapouts: number) => async (): Promise<MacMemory> => ({
		freePercent,
		swapouts,
	});

describe("whether a Mac has memory for a round", () => {
	it("has room at 35% free once its swap-outs held still for a minute", async () => {
		const watch = swapWatch();
		await macMemoryShort(mac(50, 7), watch, 0);
		expect(
			await macMemoryShort(mac(35, 7), watch, SWAP_STILL_MS),
		).toBeUndefined();
	});

	it("is short under 35% free, saying the figure", async () => {
		const watch = swapWatch();
		await macMemoryShort(mac(50, 7), watch, 0);
		expect(await macMemoryShort(mac(34, 7), watch, SWAP_STILL_MS)).toBe(
			"this Mac had 34% of memory free, under 35%",
		);
	});

	it("is short until its swap-outs have been watched for a minute", async () => {
		const watch = swapWatch();
		expect(await macMemoryShort(mac(80, 7), watch, 0)).toContain(
			"haven't yet been watched",
		);
		expect(
			await macMemoryShort(mac(80, 7), watch, SWAP_STILL_MS - 1),
		).toContain("haven't yet been watched");
	});

	it("is short when it swapped out over the last minute, and has room once that minute passes still", async () => {
		const watch = swapWatch();
		await macMemoryShort(mac(80, 7), watch, 0);
		await macMemoryShort(mac(80, 9), watch, 30_000);
		expect(await macMemoryShort(mac(80, 9), watch, SWAP_STILL_MS)).toBe(
			"this Mac swapped out 2 pages in the last 60 s",
		);
		expect(
			await macMemoryShort(mac(80, 9), watch, 30_000 + SWAP_STILL_MS),
		).toBeUndefined();
	});

	it("keeps only the readings a minute's look needs", async () => {
		const watch = swapWatch();
		for (let at = 0; at <= 10 * SWAP_STILL_MS; at += 5000) {
			await macMemoryShort(mac(80, 7), watch, at);
		}
		expect(watch.readings.length).toBeLessThanOrEqual(SWAP_STILL_MS / 5000 + 1);
	});

	it("is short, never roomy, when its memory can't be read", async () => {
		const said = await macMemoryShort(
			async () => {
				throw new Error("sysctl: unknown oid");
			},
			swapWatch(),
			0,
		);
		expect(said).toContain("couldn't be read");
		expect(said).toContain("unknown oid");
	});
});

// Off a Mac, its tools aren't there to read, which is the unread case.
describe.skipIf(process.platform === "darwin")("a Mac's own reading", () => {
	it("starts no round where the Mac's tools can't be run", async () => {
		const said = await memoryShort(async () => "", "darwin");
		expect(said).toContain("couldn't be read");
	});
});

describe("what a Mac prints of its memory", () => {
	const vmStat = [
		"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
		"Pages free:                                3627.",
		"Swapins:                                 120431.",
		"Swapouts:                                 98765.",
		"",
	].join("\n");

	it("reads the free share and the swap-outs", () => {
		expect(parseMacMemory("42\n", vmStat)).toEqual({
			freePercent: 42,
			swapouts: 98765,
		});
	});

	it("refuses a free share that isn't a figure", () => {
		expect(() => parseMacMemory("\n", vmStat)).toThrow("memorystatus_level");
	});

	it("refuses a vm_stat with no swap-outs", () => {
		expect(() => parseMacMemory("42\n", "Pages free: 3627.\n")).toThrow(
			"Swapouts",
		);
	});
});
