/**
 * Reading what a process and its reaped children used, from the
 * kernel's counters where there are any and Node's own elsewhere.
 */

import { describe, expect, it } from "vitest";
import {
	parseIo,
	parseStat,
	readCounters,
	usageBetween,
} from "../../../lib/internal/resources.ts";

/** A `/proc/self/stat` line, its CPU fields in clock ticks. */
function stat(
	name: string,
	utime: number,
	stime: number,
	cutime: number,
	cstime: number,
): string {
	const before = "S 1 4236 4236 0 -1 4194304 100 0 0 0";
	const after = "20 0 12 0 123 456 789";
	const cpu = `${utime} ${stime} ${cutime} ${cstime}`;
	return `4236 (${name}) ${before} ${cpu} ${after}\n`;
}

const IO = [
	"rchar: 652596852",
	"wchar: 352428864",
	"syscr: 100",
	"syscw: 200",
	"read_bytes: 4096",
	"write_bytes: 52625408",
	"cancelled_write_bytes: 0",
].join("\n");

describe("the kernel's counters", () => {
	it("read pi's own and its children's CPU time in milliseconds", () => {
		expect(parseStat(stat("node", 213521, 13566, 326654, 74798))).toEqual({
			selfMs: 2_270_870,
			childrenMs: 4_014_520,
		});
	});

	it("count fields from the last parenthesis, whatever the command is called", () => {
		expect(parseStat(stat("pi (main) x", 1, 2, 3, 4))).toEqual({
			selfMs: 30,
			childrenMs: 70,
		});
	});

	it("read storage bytes, not every byte through a pipe", () => {
		expect(parseIo(IO)).toEqual({ readBytes: 4096, writeBytes: 52625408 });
	});

	it("give nothing for text they do not recognise", () => {
		expect(parseStat("garbage")).toBeUndefined();
		expect(parseIo("rchar: 1")).toBeUndefined();
	});
});

describe("a reading", () => {
	const usage = () =>
		({
			userCPUTime: 1_500_000,
			systemCPUTime: 500_000,
		}) as NodeJS.ResourceUsage;

	const HEAP = {
		usedBytes: 80e6,
		totalBytes: 120e6,
		externalBytes: 9e6,
		arrayBuffersBytes: 3e6,
	};

	it("on Linux counts children and storage", () => {
		const files: Record<string, string> = {
			"/proc/self/stat": stat("node", 100, 50, 300, 20),
			"/proc/self/io": IO,
		};
		const counters = readCounters({
			platform: "linux",
			read: (path) => files[path] ?? "",
			usage,
			rss: () => 900e6,
			heap: () => HEAP,
		});
		expect(counters).toEqual({
			cpuSelfMs: 1500,
			cpuChildrenMs: 3200,
			readBytes: 4096,
			writeBytes: 52625408,
			rssBytes: 900e6,
			heap: HEAP,
		});
	});

	it("elsewhere counts pi alone, and says children were not measured", () => {
		const counters = readCounters({
			platform: "darwin",
			read: () => {
				throw new Error("no /proc here");
			},
			usage,
			rss: () => 300e6,
			heap: () => HEAP,
		});
		expect(counters).toEqual({
			cpuSelfMs: 2000,
			cpuChildrenMs: null,
			readBytes: null,
			writeBytes: null,
			rssBytes: 300e6,
			heap: HEAP,
		});
	});

	it("falls back to pi alone on Linux when /proc cannot be read", () => {
		const counters = readCounters({
			platform: "linux",
			read: () => {
				throw new Error("sandboxed");
			},
			usage,
			rss: () => 1,
		});
		expect(counters.cpuChildrenMs).toBeNull();
		expect(counters.cpuSelfMs).toBe(2000);
	});

	it("reads this process for real", () => {
		const counters = readCounters();
		expect(counters.cpuSelfMs).toBeGreaterThan(0);
		expect(counters.rssBytes).toBeGreaterThan(0);
		// The heap in use is part of what is reserved, and both are real.
		expect(counters.heap?.usedBytes).toBeGreaterThan(0);
		expect(counters.heap?.totalBytes).toBeGreaterThanOrEqual(
			counters.heap?.usedBytes ?? Number.POSITIVE_INFINITY,
		);
	});
});

describe("the use between two readings", () => {
	it("is the difference, with the memory held at the later", () => {
		const before = {
			cpuSelfMs: 100,
			cpuChildrenMs: 10,
			readBytes: 5,
			writeBytes: 6,
			rssBytes: 900,
		};
		const after = {
			cpuSelfMs: 160,
			cpuChildrenMs: 40,
			readBytes: 5,
			writeBytes: 16,
			rssBytes: 700,
		};
		expect(usageBetween(before, after)).toEqual({
			cpuSelfMs: 60,
			cpuChildrenMs: 30,
			readBytes: 0,
			writeBytes: 10,
			rssBytes: 700,
		});
	});

	it("keeps the heap as the later reading says it", () => {
		// 9 November: sessions held a median 500 MB and nothing said whether
		// the JavaScript heap or what lives outside it was what grew.
		const heap = {
			usedBytes: 2,
			totalBytes: 3,
			externalBytes: 1,
			arrayBuffersBytes: 1,
		};
		const reading = {
			cpuSelfMs: 1,
			cpuChildrenMs: 1,
			readBytes: 1,
			writeBytes: 1,
			rssBytes: 1,
		};

		expect(
			usageBetween(reading, { ...reading, heap }).heap,
			"the later heap",
		).toEqual(heap);
		expect(usageBetween(reading, reading)).not.toHaveProperty("heap");
	});

	it("is unmeasured where either reading was, and never negative", () => {
		const before = {
			cpuSelfMs: 100,
			cpuChildrenMs: 10,
			readBytes: null,
			writeBytes: 6,
			rssBytes: 1,
		};
		const after = {
			cpuSelfMs: 90,
			cpuChildrenMs: null,
			readBytes: 5,
			writeBytes: 16,
			rssBytes: 1,
		};
		expect(usageBetween(before, after)).toEqual({
			cpuSelfMs: 0,
			cpuChildrenMs: null,
			readBytes: null,
			writeBytes: 10,
			rssBytes: 1,
		});
	});
});
