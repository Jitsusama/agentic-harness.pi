/**
 * A judge records findings in the shape it was shown them. Shown
 * "who · label · where", one judge filed all twenty of its findings with
 * the label under severity and the reviewer under category, so the
 * findings it is shown name each part as its output contract does.
 */

import { describe, expect, it } from "vitest";
import { renderFindings } from "../../../../extensions/review-integration/tools/ask-round.ts";
import type { Finding } from "../../../../lib/core/review/index.ts";

/** One finding as the store holds it. */
function finding(over: Partial<Finding> = {}): Finding {
	return {
		id: 7,
		anchor: { subject: "line", path: "lib/a.ts", blob: "new", line: 12 },
		label: "issue",
		subject: "This leaks",
		discussion: "The handle is never closed.",
		origin: { kind: "reviewer", runId: "council-1", reviewerId: "hawk" },
		...over,
	};
}

describe("the findings a judge is shown", () => {
	it("names who raised each, its label, its severity and its location", () => {
		expect(
			renderFindings([finding({ severity: "medium" })]),
			"each part named as the contract names it",
		).toBe(
			"[F7] raised by hawk · label: issue · severity: medium · location: lib/a.ts:12\nThis leaks\nThe handle is never closed.",
		);
	});

	it("leaves out a severity the finding has none of", () => {
		const shown = renderFindings([
			finding({ anchor: { subject: "change" }, label: "question" }),
		]);

		expect(shown, "no severity, and the change as a whole").toContain(
			"[F7] raised by hawk · label: question · location: the change as a whole\n",
		);
	});
});
