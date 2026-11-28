/**
 * A reviewer no room took says so in the round, not as a bare exit: it
 * never had a child here, so the supervisor's warning is its only
 * reason, and the round reads a failure from its error and stderr alone.
 */

import { describe, expect, it } from "vitest";
import { answerFromReviewer } from "../../../../extensions/review-integration/reviewer.ts";
import type { RunReviewerResult } from "../../../../lib/subagent/index.ts";

/** What the supervisor hands back for a reviewer that failed with nothing said. */
const failed = (over: Partial<RunReviewerResult> = {}): RunReviewerResult => ({
	reviewerId: "security",
	exitCode: 1,
	finalAssistantText: "",
	stderr: "",
	warnings: [],
	sessionIds: null,
	...over,
});

/** What the round is told of the failure, or nothing where it answered. */
const failureOf = (result: RunReviewerResult): string | undefined => {
	const answer = answerFromReviewer(result);
	return "failure" in answer ? answer.failure : undefined;
};

const NO_SLOT =
	"No room could take this reviewer (no machine has a slot), and it doesn't run here: ask the round again once the room is back.";

describe("a room reviewer that fails", () => {
	it("says why no room took it", () => {
		expect(failureOf(failed({ warnings: ["other", NO_SLOT] }))).toBe(NO_SLOT);
	});

	it("says a room that ran it gave nothing back", () => {
		const gaveNothing =
			"No room ran this reviewer (exited 255: refused), and it doesn't run here: ask again.";

		expect(failureOf(failed({ warnings: [gaveNothing] }))).toBe(gaveNothing);
	});

	it("still prefers its own stderr, and says the exit with nothing at all", () => {
		expect(failureOf(failed({ stderr: "boom", warnings: [NO_SLOT] }))).toBe(
			"boom",
		);
		expect(failureOf(failed())).toBe("security exited 1 without answering.");
	});
});
