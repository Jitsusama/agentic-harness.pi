/** The kernel's boot time is read once a process, not once an ask. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The kernel's own file stands in for itself on every platform, so a
// Mac, with no /proc, counts the same reads Linux does.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: vi.fn((path: unknown, ...rest: unknown[]) =>
			path === "/proc/stat"
				? "cpu  1 2 3\nbtime 1792864593\n"
				: Reflect.apply(fs.readFileSync, fs, [path, ...rest]),
		),
	};
});

describe("the kernel's boot time", () => {
	it("is read from the kernel once, however often it is asked", async () => {
		// A setup file may have loaded the module over the real disk, so
		// this test takes a copy of its own, made over the mocked one.
		vi.resetModules();
		const { machineBooted } = await import(
			"../../../../lib/internal/machine/booted.ts"
		);

		const asks = [machineBooted(), machineBooted(), machineBooted()];

		expect(asks).toEqual([1792864593000, 1792864593000, 1792864593000]);
		const statReads = vi
			.mocked(readFileSync)
			.mock.calls.filter(([path]) => path === "/proc/stat");
		expect(statReads).toHaveLength(1);
	});
});
