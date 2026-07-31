/**
 * The prose gate on the road that does not run a command.
 *
 * A commit typed into a shell meets the commit guardian, which reaches it by
 * intercepting the command. `work record` never runs a command: it commits through the
 * exec seam, so it arrived behind the guardian rather than in front of it. A
 * convention enforced on one road into the same repository and not the other is not
 * enforced, it is inconvenient in one place.
 *
 * This tests the shared decision rather than the tool's wiring, which is where the
 * rule actually lives. The wiring is one call and a narrowing.
 */

import { describe, expect, it } from "vitest";
import {
	detectProseViolations,
	proseGateDecision,
} from "../../lib/prose/index.js";

/** The gate's answer for a message nobody has been warned about yet. */
function firstAnswer(message: string) {
	return proseGateDecision(detectProseViolations(message), [], message);
}

describe("a commit message recorded through the work tool", () => {
	it("is blocked for an emdash, the same as one typed into a shell", () => {
		const answer = firstAnswer(
			"fix(work): tidy the seam\n\nThis reads well \u2014 and that dash is the problem.",
		);

		expect(answer.action).toBe("block");
	});

	it("is blocked for curly quotes", () => {
		const answer = firstAnswer(
			"fix(work): tidy the seam\n\nIt said \u201cno\u201d and meant it.",
		);

		expect(answer.action).toBe("block");
	});

	it("passes a message that follows the standard", () => {
		// The case that matters most: a gate that blocks everything teaches people to
		// bypass it, so the ordinary well-formed message has to go straight through.
		const answer = firstAnswer(
			"fix(work): scope every git call to its tree\n\nAn unscoped call runs wherever the process sits and answers confidently about the wrong repository.",
		);

		expect(answer.action).not.toBe("block");
	});

	it("relents when the same message comes back, rather than looping", () => {
		// The AI has had its chance by then. Blocking again would spin, so the human
		// becomes the safety net instead.
		const message = "fix(work): tidy\n\nA dash \u2014 again.";
		const first = firstAnswer(message);
		expect(first.action).toBe("block");

		const again = proseGateDecision(
			detectProseViolations(message),
			[first.signature],
			message,
		);

		expect(again.action).not.toBe("block");
	});
});
