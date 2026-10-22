/**
 * A batch holding a `work` call runs in the order it was written.
 *
 * pi runs one message's tool calls side by side unless one of them is to a
 * tool marked sequential, and then it runs the whole batch one call at a
 * time, in order. Twice a work call raced a shell command written before it
 * in the same batch: a resume read the tree before the `git add` beside it
 * (19 October), and a branch read it before the `git revert --abort` beside
 * it had cleaned up (20 October). Each was reported as a halt or a failure
 * that was not true by the time anyone looked.
 */

import { describe, expect, it } from "vitest";
import workIntegration from "../../extensions/work-integration/index.ts";
import { activateWith, toolNamed } from "./support/review-extension.ts";

describe("the work tool", () => {
	it("is marked sequential, so its batch runs in the order it was written", () => {
		const work = toolNamed(activateWith(workIntegration), "work");

		expect(work).toMatchObject({ executionMode: "sequential" });
	});
});
