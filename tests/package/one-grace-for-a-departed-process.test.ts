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

	it("is read at the timer, not merely imported nearby", () => {
		// Banning the declaration bans one spelling of the drift, and
		// the cheapest way back is a bare number at the use site while
		// the import sits above it unread. So this pins where the value
		// is spent rather than where it is named.
		//
		// Three readers, because the parent's budget is a sum this is a
		// term in and the test that checks that sum held the fourth copy
		// of the number, under a comment conceding a stale one would go
		// on passing while documenting the wrong value.
		const readers = {
			"supervisor.mjs": source("supervisor.mjs"),
			"supervisor.ts": source("supervisor.ts"),
			"supervisor.test.ts": readFileSync(
				join(ROOT, "tests", "lib", "subagent", "runpi", "supervisor.test.ts"),
				"utf8",
			),
		};

		for (const [name, text] of Object.entries(readers)) {
			expect(name && text).toBeTruthy();
			expect(text).not.toMatch(/(?:const|let)\s+STDIO_GRACE_MS\s*=/);
			expect(text).toContain("STDIO_GRACE_MS");
		}
		// The two timers this governs, named where they are armed.
		expect(readers["supervisor.mjs"]).toContain("}, STDIO_GRACE_MS);");
		expect(readers["supervisor.ts"]).toContain("}, STDIO_GRACE_MS);");
	});

	it("is not overtaken by the report a stop arms behind it", () => {
		// The rung that made this dangerous. A stop arms the answer of
		// last resort at twice the kill grace, so the drain owned the
		// rest of the shutdown only while it was shorter than the kill
		// grace, which nothing stated and nothing checked. Raising the
		// drain to the measured value made them level at the default and
		// handed every stopped run to the last resort, which says the
		// reviewer may never have started.
		//
		// The repair is not another number: a child that has exited has
		// answered that question, so its exit disarms the report.
		expect(source("supervisor.mjs")).toMatch(
			/child\.once\("exit"[\s\S]{0,900}?clearTimeout\(reportTimer\)/,
		);
	});
});
