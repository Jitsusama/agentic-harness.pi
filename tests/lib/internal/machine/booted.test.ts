import { describe, expect, it } from "vitest";
import {
	bootReadOnce,
	machineBooted,
} from "../../../../lib/internal/machine/booted.ts";

describe("when the machine booted", () => {
	it("is the kernel's btime, in milliseconds", () => {
		const stat = "cpu  1 2 3\nintr 9\nbtime 1792864593\nprocesses 4\n";

		expect(machineBooted(() => stat)).toBe(1792864593000);
	});

	it("is nothing where the machine will not say", () => {
		expect(machineBooted(() => "cpu  1 2 3\n")).toBeUndefined();
		expect(
			machineBooted(() => {
				throw new Error("ENOENT: /proc/stat");
			}),
		).toBeUndefined();
	});

	it("reads a given source each time it is asked", () => {
		let reads = 0;
		const read = () => {
			reads += 1;
			return "btime 1792864593\n";
		};

		machineBooted(read);
		machineBooted(read);

		expect(reads).toBe(2);
	});

	it("keeps its first answer, however often it is asked", () => {
		let reads = 0;
		const booted = bootReadOnce(
			() => {
				reads += 1;
				return "cpu  1 2 3\nbtime 1792864593\n";
			},
			() => 0,
		);

		expect([booted(), booted(), booted()]).toEqual([
			1792864593000, 1792864593000, 1792864593000,
		]);
		expect(reads).toBe(1);
	});

	it("reads again after a read that couldn't say", () => {
		let reads = 0;
		const booted = bootReadOnce(() => {
			reads += 1;
			if (reads === 1) throw new Error("EMFILE: too many open files");
			return reads === 2 ? "cpu  1 2 3\n" : "btime 1792864593\n";
		});

		expect(booted()).toBeUndefined();
		expect(booted()).toBeUndefined();
		expect(booted()).toBe(1792864593000);
		expect(booted()).toBe(1792864593000);
		expect(reads).toBe(3);
	});

	it("reads again once the wall clock is stepped, and not as it slews", () => {
		const answers = ["btime 1792864593\n", "btime 1792861000\n"];
		let reads = 0;
		let clock = 0;
		const booted = bootReadOnce(
			() => answers[Math.min(reads++, 1)] ?? "",
			() => clock,
		);

		expect(booted()).toBe(1792864593000);
		clock = 900;
		expect(booted()).toBe(1792864593000);
		clock = -3_593_000;
		expect(booted()).toBe(1792861000000);
		expect(booted()).toBe(1792861000000);
		expect(reads).toBe(2);
	});

	it("answers the kernel's boot the same each time", () => {
		expect(machineBooted()).toBe(machineBooted());
	});
});
