/**
 * A Mac's room, read in the terms the queue's turn rules read on Linux.
 * The fixtures are what equilibrius answered on 29 October.
 */

import { describe, expect, it } from "vitest";
import { MOST_MEMORY_PRESSURE } from "../../../../lib/internal/priority/queue.ts";
import {
	type DarwinFacts,
	darwinFactsFrom,
	darwinRoom,
	guestsIn,
	SWAPPING_MS,
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
		expect(readingOf({ ...calm, availablePercent: 19 })().memoryPressure).toBe(
			MOST_MEMORY_PRESSURE,
		);
	});

	it("holds work while it swaps out, and not once swapping has stopped", () => {
		const read = readingOf(
			calm,
			{ ...calm, swapouts: 60 },
			{ ...calm, swapouts: 60 },
		);
		expect(read().memoryPressure).toBe(0);
		expect(read(2_000).memoryPressure).toBe(MOST_MEMORY_PRESSURE);
		expect(read(SWAPPING_MS + 1).memoryPressure).toBe(0);
	});

	it("reads load past the cores as the share of work waiting, as PSI does", () => {
		expect(readingOf({ ...calm, load: 12 })().cpuPressure).toBe(0);
		expect(readingOf({ ...calm, load: 24 })().cpuPressure).toBe(50);
	});

	it("counts its VM guests as VMs", () => {
		expect(readingOf({ ...calm, guests: 1 })().vms).toBe(1);
	});
});
