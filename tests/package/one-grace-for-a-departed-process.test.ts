/**
 * One grace, read by both halves of the supervisor.
 *
 * A reviewer's pipes and a supervisor's pipes are the same hazard one
 * level apart: a process has exited, something it started still holds
 * its output, and whoever waits has to decide when to finish without
 * it. Holding that decision twice is how the two came to disagree,
 * and they disagreed in the direction that loses work.
 *
 * The parent's copy had already been raised to five seconds, with a
 * docstring recording that two was measured to be too short and that
 * the failure it produced was an empty answer, which reads as a
 * reviewer that said nothing rather than as a deadline that was too
 * tight. The supervisor's copy, the one draining the reviewer that
 * actually produces the answer, was still two.
 *
 * Beside the journal's gate because it is the same kind of join: a
 * fact two processes have to agree on across a seam neither type
 * checking nor a rename can cross, where every way it breaks is
 * silent.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STDIO_GRACE_MS } from "../../lib/subagent/runpi/grace.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNPI = join(ROOT, "lib", "subagent", "runpi");

const source = (file: string) => readFileSync(join(RUNPI, file), "utf8");

describe("the grace a departed process gets to flush", () => {
	it("is long enough for the flush that was measured to overrun", () => {
		// Not a round number chosen for looking reasonable. Two seconds
		// was measured to be too short on a loaded machine, where what
		// still has to happen after exit is a spawn, a flush through
		// inherited pipes and an atomic write.
		expect(STDIO_GRACE_MS).toBeGreaterThanOrEqual(5_000);
	});

	it("is declared once, not once per half", () => {
		// The two halves cannot come to share a value by accident: one
		// is a script node runs directly and the other is TypeScript,
		// and that seam is exactly where the numbers drifted. The drift
		// is invisible from either side, since each is self-consistent
		// and only a reviewer's missing output says otherwise.
		for (const file of ["supervisor.mjs", "supervisor.ts"]) {
			expect(source(file)).not.toMatch(/const STDIO_GRACE_MS\s*=/);
			expect(source(file)).toContain("STDIO_GRACE_MS");
		}
	});

	it("is what the parent's own budget is built from", () => {
		// The parent's grace has to cover the supervisor's whole
		// shutdown, and the pipe drain is one term in that sum. A test
		// mirroring the number by hand was the fourth copy, with a
		// comment conceding that a stale one would go on passing while
		// documenting the wrong value.
		expect(source("supervisor.ts")).toContain("STDIO_GRACE_MS");
		expect(
			readFileSync(
				join(ROOT, "tests", "lib", "subagent", "runpi", "supervisor.test.ts"),
				"utf8",
			),
		).not.toMatch(/const STDIO_GRACE_MS\s*=/);
	});
});
