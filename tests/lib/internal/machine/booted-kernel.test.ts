/** The kernel's boot time is read once a process, not once an ask. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the kernel's file says, which a test may change, as a stepped
// wall clock changes the kernel's `btime`.
const kernel = vi.hoisted(() => ({ stat: "" }));

// The kernel's own file stands in for itself on every platform, so a
// Mac, with no /proc, counts the same reads Linux does.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: vi.fn((path: unknown, ...rest: unknown[]) =>
			path === "/proc/stat"
				? kernel.stat
				: Reflect.apply(fs.readFileSync, fs, [path, ...rest]),
		),
	};
});

/**
 * A fresh copy of the module, made over the mocked disk: a setup file
 * may have loaded it over the real one, and each copy keeps its own.
 */
async function freshBooted(): Promise<() => number | undefined> {
	vi.resetModules();
	const { machineBooted } = await import(
		"../../../../lib/internal/machine/booted.ts"
	);
	return () => machineBooted();
}

function statReads(): number {
	return vi
		.mocked(readFileSync)
		.mock.calls.filter(([path]) => path === "/proc/stat").length;
}

describe("the kernel's boot time", () => {
	beforeEach(() => {
		kernel.stat = "cpu  1 2 3\nbtime 1792864593\n";
		vi.mocked(readFileSync).mockClear();
		vi.useFakeTimers({ toFake: ["Date", "performance"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("is read from the kernel once, however often it is asked", async () => {
		const booted = await freshBooted();

		expect([booted(), booted(), booted()]).toEqual([
			1792864593000, 1792864593000, 1792864593000,
		]);
		expect(statReads()).toBe(1);
	});

	it("is kept as time passes on the machine's own clocks", async () => {
		const booted = await freshBooted();

		expect(booted()).toBe(1792864593000);
		vi.advanceTimersByTime(60 * 60 * 1000);
		expect(booted()).toBe(1792864593000);

		expect(statReads()).toBe(1);
	});

	it("is read again once the wall clock is stepped", async () => {
		const booted = await freshBooted();

		expect(booted()).toBe(1792864593000);
		vi.setSystemTime(Date.now() - 3_593_000);
		kernel.stat = "cpu  1 2 3\nbtime 1792861000\n";

		expect(booted()).toBe(1792861000000);
		expect(statReads()).toBe(2);
	});
});
