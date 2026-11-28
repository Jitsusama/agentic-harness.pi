/**
 * Every clock over a piece of work is a `deadline`, never node's own
 * timeout signal.
 *
 * On node 22, a signal joined by `AbortSignal.any` to a timeout signal
 * is kept for good once another of its sources aborts it, and with it
 * whatever that abort's callers held: one pi kept 164 of its 475 MiB
 * so. `deadline` (`lib/clock/deadline.ts`) is made from a plain
 * controller, which nothing keeps; this keeps a timeout signal from
 * coming back where nothing else would notice the memory it costs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SEARCHED = ["extensions", "packs", "lib", "host", "scripts"];
const TIMEOUT_SIGNAL = /AbortSignal\s*\.\s*timeout\s*\(/u;

function sources(folder: string): string[] {
	return readdirSync(join(ROOT, folder), {
		recursive: true,
		withFileTypes: true,
	})
		.filter(
			(entry) =>
				entry.isFile() &&
				/\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(entry.name) &&
				!entry.parentPath.includes("node_modules"),
		)
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

describe("a clock over some work", () => {
	it("is a deadline, never node's own timeout signal", () => {
		const timed = SEARCHED.flatMap(sources).filter((file) =>
			TIMEOUT_SIGNAL.test(readFileSync(join(ROOT, file), "utf8")),
		);

		expect(timed, "files making a timeout signal").toEqual([]);
	});

	it("sees one where it is made", () => {
		expect(TIMEOUT_SIGNAL.test("AbortSignal.timeout(JUDGE_MS)")).toBe(true);
		expect(TIMEOUT_SIGNAL.test("AbortSignal .timeout (5)")).toBe(true);
		expect(TIMEOUT_SIGNAL.test("rather than `AbortSignal.timeout`")).toBe(
			false,
		);
	});
});
