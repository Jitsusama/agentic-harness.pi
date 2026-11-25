/**
 * A Mac's room, read in the terms the queue's turn rules read on Linux.
 * The fixtures are what equilibrius answered on 29 October.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOST_MEMORY_PRESSURE } from "../../../../lib/internal/priority/queue.ts";
import {
	BASELINE_MS,
	type DarwinFacts,
	darwinFactsFrom,
	darwinRoom,
	guestsIn,
	historyIn,
	historyInMemory,
	LEAST_AVAILABLE_PERCENT,
	SWAP_FILE,
	SWAPPING_MS,
	type SwapHistory,
	swapoutsIn,
} from "../../../../lib/internal/priority/room-darwin.ts";

const SYSCTL = `hw.memsize: 51539607552
hw.ncpu: 12
kern.memorystatus_level: 95
kern.memorystatus_vm_pressure_level: 1
vm.loadavg: { 1.11 1.63 1.75 }
`;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   689093.
Pageouts:                                       1622.
Swapins:                                           0.
Swapouts:                                         42.
`;

const GIB = 1024 ** 3;

describe("what a Mac's kernel says", () => {
	it("reads sysctl's, vm_stat's and ps's answers", () => {
		expect(
			darwinFactsFrom(SYSCTL, VM_STAT, [
				"/usr/libexec/logd",
				"com.apple.Virtualization.VirtualMachine",
			]),
		).toEqual({
			memsize: 51539607552,
			cores: 12,
			availablePercent: 95,
			pressureLevel: 1,
			load: 1.11,
			swapouts: 42,
			guests: 1,
		});
	});

	it("counts Virtualization.framework and qemu guests, and nothing named like them", () => {
		expect(
			guestsIn([
				"com.apple.Virtualization.VirtualMachine",
				"/nix/store/abc-qemu-8.2/bin/qemu-system-aarch64",
				"com.apple.Virtualization.VirtualMachine.xpc-helper",
				"qemu-img",
			]),
		).toBe(2);
		expect(swapoutsIn("Pages free: 1.\n")).toBe(0);
	});
});

describe("a Mac's room", () => {
	const calm: DarwinFacts = {
		memsize: 48 * GIB,
		cores: 12,
		availablePercent: 95,
		pressureLevel: 1,
		load: 1.1,
		swapouts: 42,
		guests: 0,
	};
	const readingOf = (...facts: DarwinFacts[]) => {
		let now = 0;
		let at = 0;
		const read = darwinRoom(
			() => facts[Math.min(at++, facts.length - 1)] as DarwinFacts,
			() => now,
		);
		return (advance = 0) => {
			now += advance;
			return read();
		};
	};
	/** A session's reading of the room, at the time it is asked at. */
	const sessionOn =
		(history: SwapHistory) => (facts: DarwinFacts, at: number) =>
			darwinRoom(
				() => facts,
				() => at,
				history,
			)().memoryPressure;

	it("reads a calm Mac as having its available memory and no pressure", () => {
		const room = readingOf(calm)();
		expect(room.availableGib).toBeCloseTo(45.6, 1);
		expect(room.memoryPressure).toBe(0);
		expect(room.cpuPressure).toBe(0);
		expect(room.vms).toBe(0);
		expect(room.cores).toBe(12);
	});

	it("holds work at the kernel's warning, or with little memory left", () => {
		expect(readingOf({ ...calm, pressureLevel: 2 })().memoryPressure).toBe(
			MOST_MEMORY_PRESSURE,
		);
		expect(readingOf({ ...calm, pressureLevel: 4 })().memoryPressure).toBe(
			MOST_MEMORY_PRESSURE,
		);
		expect(
			readingOf({ ...calm, availablePercent: 30 })().memoryPressure,
			"30% available is under velocity's Mac line",
		).toBe(MOST_MEMORY_PRESSURE);
		expect(
			readingOf({ ...calm, availablePercent: LEAST_AVAILABLE_PERCENT })()
				.memoryPressure,
			"the line itself is room",
		).toBe(0);
	});

	it("holds work while it swaps out, and not once swapping has stopped", () => {
		const read = readingOf(
			{ ...calm, availablePercent: 50 },
			{ ...calm, availablePercent: 50, swapouts: 60 },
			{ ...calm, availablePercent: 50, swapouts: 60 },
			{ ...calm, availablePercent: 50, swapouts: 60 },
		);
		expect(read().memoryPressure).toBe(0);
		expect(read(2_000).memoryPressure).toBe(MOST_MEMORY_PRESSURE);
		expect(
			read(30_000).memoryPressure,
			"50% available with a swap-out 30 s ago still holds",
		).toBe(MOST_MEMORY_PRESSURE);
		expect(
			read(SWAPPING_MS).memoryPressure,
			"a minute with no swap-out is room again",
		).toBe(0);
	});

	it("sees a swap-out another session read first, as the machine's history is one", () => {
		const shared = sessionOn(historyInMemory());
		expect(shared(calm, 0), "the first session read no swap-out").toBe(0);
		expect(
			shared({ ...calm, swapouts: 60 }, 30_000),
			"the second session's first reading sees the first's",
		).toBe(MOST_MEMORY_PRESSURE);

		const apart = (facts: DarwinFacts, at: number) =>
			sessionOn(historyInMemory())(facts, at);
		apart(calm, 0);
		expect(
			apart({ ...calm, swapouts: 60 }, 30_000),
			"a history of its own sees nothing on its first reading",
		).toBe(0);
	});

	it("keeps the history in the queue's folder, for every session there", () => {
		const dir = mkdtempSync(join(tmpdir(), "queue-swaps-"));
		try {
			sessionOn(historyIn(dir))(calm, 0);
			expect(
				sessionOn(historyIn(dir))({ ...calm, swapouts: 60 }, 30_000),
				"a session reading the folder later sees the swap-out",
			).toBe(MOST_MEMORY_PRESSURE);

			writeFileSync(join(dir, SWAP_FILE), "[{half");
			expect(
				sessionOn(historyIn(dir))({ ...calm, swapouts: 60 }, 31_000),
				"a history it can't read starts again",
			).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads no swapping from a count a boot reset, or from a reading long gone", () => {
		const rebooted = sessionOn(historyInMemory());
		rebooted({ ...calm, swapouts: 900 }, 0);
		expect(
			rebooted({ ...calm, swapouts: 60 }, 30_000),
			"a count under the last is a new boot's",
		).toBe(0);

		const idle = sessionOn(historyInMemory());
		idle(calm, 0);
		expect(
			idle({ ...calm, swapouts: 60 }, BASELINE_MS + 1),
			"a reading past the baseline's age says nothing of now",
		).toBe(0);
	});

	it("reads load past the cores as the share of work waiting, as PSI does", () => {
		expect(readingOf({ ...calm, load: 12 })().cpuPressure).toBe(0);
		expect(readingOf({ ...calm, load: 24 })().cpuPressure).toBe(50);
	});

	it("counts its VM guests as VMs", () => {
		expect(readingOf({ ...calm, guests: 1 })().vms).toBe(1);
	});
});
