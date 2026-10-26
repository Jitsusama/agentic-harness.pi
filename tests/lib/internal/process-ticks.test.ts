/**
 * A process's start in ticks since boot, read from /proc.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startTicksFromProc } from "../../../lib/internal/process-ticks.ts";

const hasProc = existsSync(`/proc/${process.pid}/stat`);

describe("a process's start in ticks", () => {
	it.runIf(hasProc)("is a count, the same each time it is read", async () => {
		const first = await startTicksFromProc(process.pid);

		expect(Number.isSafeInteger(first)).toBe(true);
		expect(await startTicksFromProc(process.pid)).toBe(first);
	});

	it("is nothing for a process that is not there", async () => {
		expect(await startTicksFromProc(2 ** 30)).toBeUndefined();
	});
});
