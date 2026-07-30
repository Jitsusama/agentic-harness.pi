/**
 * A round nobody can stop must stop itself.
 *
 * `review_ask` spawns a subprocess per participant, and pi hands a
 * tool's execute no cancellation signal, so there is no key to press: a
 * participant that stops responding runs until something times it out.
 * The runner's own ceiling is forty-five minutes, which is a reasonable
 * default for a long autonomous job and far too long for a reviewer
 * reading a diff.
 *
 * So the bound is asserted rather than assumed, and asserted against
 * the runner's default rather than against a number written twice: a
 * test that repeats the constant passes when both are wrong together.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PARTICIPANT_TIMEOUT_MS } from "../../extensions/review-integration/progress.js";
import { DEFAULT_RUN_PI_TIMEOUT_MS } from "../../lib/subagent/runpi/spawn.js";

describe("a participant's run is bounded", () => {
	it("is bounded well inside the runner's own ceiling", () => {
		expect(PARTICIPANT_TIMEOUT_MS).toBeLessThan(DEFAULT_RUN_PI_TIMEOUT_MS);
	});

	it("still leaves room for a round that legitimately takes minutes", () => {
		// The longest council round observed spent about two and a half
		// minutes before its first output. A bound near that would
		// truncate honest work, so this asserts real headroom rather
		// than merely being under the ceiling.
		const observedLongestRoundMs = 3 * 60 * 1000;

		expect(PARTICIPANT_TIMEOUT_MS).toBeGreaterThan(observedLongestRoundMs * 2);
	});

	it("is actually passed to the runner", () => {
		// The constant existing proves nothing; the wiring is the claim.
		// Read as source because the options are built inside a closure
		// that a test cannot otherwise reach.
		const source = readFileSync(
			join(process.cwd(), "extensions/review-integration/tools/ask.ts"),
			"utf8",
		);

		expect(source).toContain("timeoutMs: PARTICIPANT_TIMEOUT_MS");
	});
});
