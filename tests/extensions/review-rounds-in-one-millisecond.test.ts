/**
 * Two rounds a session starts in the same millisecond have two ids.
 *
 * Seen: three rounds a script started at once were all named
 * `council-20261105T014337915-000001`, because every round passed a
 * sequence of 1. Their reviewers shared one artifact directory, so one
 * round started two of its four and another three.
 */

import { describe, expect, it } from "vitest";
import { nextSeq } from "../../extensions/review-integration/tools/ask.ts";
import { newRunId } from "../../lib/core/review/index.ts";

describe("rounds started in the same millisecond", () => {
	it("are named apart", () => {
		const at = new Date("2026-11-05T01:43:37.915Z");

		const ids = [nextSeq(), nextSeq(), nextSeq()].map((seq) =>
			newRunId("council", at, seq),
		);

		expect(new Set(ids).size).toBe(3);
	});
});
