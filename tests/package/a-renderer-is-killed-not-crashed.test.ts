/**
 * A test that needs a dead renderer kills it rather than crashing it.
 *
 * Loading Chrome's crash page makes the renderer fault for real, so
 * the kernel hands systemd-coredump a core of it to compress and keep.
 * The browser lane did that five times a run: on optimus, 88 of the
 * week's 248 Chrome core dumps to 12 November came from test runs.
 * Chrome's kill page ends the
 * renderer just as suddenly, and DevTools reports the target crashed
 * all the same, but nothing faults and nothing is dumped.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../scripts/ts-import-specifiers.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** Built in two halves so this file doesn't name it whole. */
const CRASH_PAGE = ["chrome://", "crash"].join("");

describe("a renderer a test ends", () => {
	it("is killed through chrome://kill, never crashed into a core dump", () => {
		const crashing = sourceFiles(ROOT).flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.flatMap((text, index) =>
					text.includes(CRASH_PAGE)
						? [`${relative(ROOT, file)}:${index + 1}`]
						: [],
				),
		);
		expect(
			crashing,
			"these load the crash page, which leaves a core dump; load chrome://kill instead",
		).toEqual([]);
	});
});
