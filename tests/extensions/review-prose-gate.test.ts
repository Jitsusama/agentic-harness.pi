/**
 * The prose standard applies hardest where the writing leaves.
 *
 * Most of what a review says was written by a model, and models emit
 * emdashes, curly quotes and Unicode ellipses by default. The extension
 * these tools replaced gated the review body and every comment body for
 * exactly that reason, and losing the gate would be invisible until
 * somebody else read the comment.
 */

import { describe, expect, it } from "vitest";
import { proseComplaint } from "../../extensions/review-integration/render.js";
import type { PublishPlan } from "../../lib/review/index.js";

/** A plan carrying one review with the given body and comment bodies. */
function planWith(body: string, ...comments: string[]): PublishPlan {
	return {
		ops: [
			{
				kind: "review",
				verdict: "comment",
				body,
				comments: comments.map((text, at) => ({
					body: text,
					anchor: { subject: "change" as const },
					itemId: String(at),
				})),
				itemIds: ["0"],
			},
		],
		degraded: [],
		refused: [],
	} as unknown as PublishPlan;
}

describe("refusing to publish prose that breaks the standard", () => {
	it("passes clean prose", () => {
		expect(proseComplaint(planWith("This leaks a handle."))).toBeUndefined();
	});

	it("catches an emdash in the review body", () => {
		const complaint = proseComplaint(planWith("This leaks \u2014 badly."));

		expect(complaint).toBeDefined();
		expect(complaint).toContain("not ready to send");
	});

	it("catches it in an anchored comment, not just the body", () => {
		// The comments are the part a model wrote, so checking only the
		// summary would miss almost every real case.
		const complaint = proseComplaint(
			planWith("Clean summary.", "The handle \u2014 never closed."),
		);

		expect(complaint).toBeDefined();
	});

	it("catches curly quotes and a Unicode ellipsis", () => {
		expect(proseComplaint(planWith("It\u2019s wrong"))).toBeDefined();
		expect(proseComplaint(planWith("And so on\u2026"))).toBeDefined();
	});

	it("says one habit once rather than once per instance", () => {
		// Forty emdashes is one thing to fix. Listing forty buries it.
		const complaint = proseComplaint(
			planWith("a \u2014 b \u2014 c \u2014 d \u2014 e"),
		);
		const lines = (complaint ?? "").split("\n");

		expect(lines.filter((line) => line.includes("times"))).toHaveLength(1);
	});

	it("ignores an op that carries no prose at all", () => {
		const plan = {
			ops: [{ kind: "resolve", thread: {}, itemIds: ["0"] }],
			degraded: [],
			refused: [],
		} as unknown as PublishPlan;

		expect(proseComplaint(plan)).toBeUndefined();
	});

	it("ignores a body that is only whitespace", () => {
		expect(proseComplaint(planWith("   "))).toBeUndefined();
	});

	it("does not object to an emdash inside code", () => {
		// The detector masks fenced and inline code, and a review quoting
		// the offending line is the commonest reason to write one.
		expect(
			proseComplaint(planWith("Look at `a \u2014 b` here.")),
		).toBeUndefined();
	});

	it("reads a remark that travels on its own", () => {
		// A whole-file remark is posted outside the review, because neither
		// backend will carry one inside a batch. It is still prose somebody
		// else reads, and leaving it out would have made this gate's coverage
		// depend on which request happened to carry the text: the same remark
		// would pass or fail by where the provider decided to put it.
		const plan = {
			ops: [
				{
					kind: "commentOn",
					comment: {
						body: "This file leaks \u2014 badly.",
						anchor: { subject: "file", path: "lib/app.ts" },
					},
					itemIds: ["0"],
				},
			],
			degraded: [],
			refused: [],
		} as unknown as PublishPlan;

		expect(proseComplaint(plan)).toBeDefined();
	});
});
