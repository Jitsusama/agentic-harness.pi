/**
 * A gate you cannot argue with is a gate nobody reads.
 *
 * `Shift+Escape` is the universal redirect, and it is how somebody
 * steers a write that is nearly right. The review gates used to read
 * any result that was not the reject key as approval, so the one
 * gesture for saying "not like that" posted the thing being steered
 * away from, and dropped the sentence explaining why. `Shift+r`'s
 * annotation went the same way.
 *
 * The mapping is pure so it can be checked here rather than in a
 * terminal: everything a person can do at a panel, and what each one
 * means for the write waiting behind it.
 */

import { describe, expect, it } from "vitest";
import { decisionOf } from "../../extensions/review-integration/gate.js";

/** What both prompts report for a plain Enter. Their sentinel, not ours. */
const SUBMIT = "__enter__";

describe("what a person decided at a write gate", () => {
	it("approves on a plain submit", () => {
		expect(decisionOf({ type: "action", key: SUBMIT })).toEqual({
			approved: true,
		});
	});

	it("carries a note left on an approval, so the transcript keeps it", () => {
		expect(
			decisionOf({ type: "action", key: SUBMIT, note: "ship it" }),
		).toEqual({ approved: true, note: "ship it" });
	});

	it("refuses on the reject key", () => {
		expect(decisionOf({ type: "action", key: "r" })).toEqual({
			approved: false,
		});
	});

	it("refuses with the note when a rejection was annotated", () => {
		expect(
			decisionOf({ type: "action", key: "r", note: "wrong thread" }),
		).toEqual({ approved: false, redirect: "wrong thread" });
	});

	it("refuses and keeps the note on a redirect, which used to approve", () => {
		expect(
			decisionOf({ type: "redirect", note: "answer binks first" }),
		).toEqual({ approved: false, redirect: "answer binks first" });
	});

	it("refuses on cancel", () => {
		expect(decisionOf(null)).toEqual({ approved: false });
	});

	it("ignores an empty note rather than reporting a redirect with no words", () => {
		expect(decisionOf({ type: "action", key: "r", note: "   " })).toEqual({
			approved: false,
		});
	});
});
