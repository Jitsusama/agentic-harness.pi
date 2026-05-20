import { describe, expect, it } from "vitest";
import { postGateOutcome } from "../../../extensions/pr-workflow/post-gate-outcome.js";

describe("postGateOutcome", () => {
	const body = "Council review: 3 finding(s) posted.";

	it("approves with the original body when no action key fires", () => {
		expect(postGateOutcome({ type: "action", key: "x" }, body)).toEqual({
			approved: true,
			body,
		});
	});

	it("rejects on the explicit `r` action", () => {
		expect(postGateOutcome({ type: "action", key: "r" }, body)).toEqual({
			approved: false,
			reason: "User rejected the review post.",
		});
	});

	it("treats null result as cancellation", () => {
		expect(postGateOutcome(null, body)).toEqual({
			approved: false,
			reason: "User cancelled the review post.",
		});
	});

	it("turns Shift+Enter annotations into steering rejections", () => {
		expect(
			postGateOutcome(
				{ type: "action", key: "a", note: "wait for CI first" },
				body,
			),
		).toEqual({
			approved: false,
			reason: "User annotated: wait for CI first",
		});
	});

	it("replaces the body when the user redirects with non-empty text", () => {
		expect(
			postGateOutcome({ type: "redirect", note: "Better summary" }, body),
		).toEqual({ approved: true, body: "Better summary" });
	});

	it("rejects an empty redirect body to avoid silently posting whitespace", () => {
		expect(postGateOutcome({ type: "redirect", note: "  " }, body)).toEqual({
			approved: false,
			reason: "Redirected review body was empty.",
		});
	});
});
