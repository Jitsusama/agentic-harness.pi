import { describe, expect, it } from "vitest";
import {
	replyGateOutcome,
	resolveGateOutcome,
} from "../../../extensions/pr-workflow/thread-gate-outcome.js";

describe("replyGateOutcome", () => {
	it("turns action annotations into steering rejections", () => {
		const result = replyGateOutcome(
			{ type: "action", key: "a", note: "mention the test name" },
			"original",
		);

		expect(result).toEqual({
			approved: false,
			reason: "User annotated: mention the test name",
		});
	});

	it("preserves redirect edits as the approved body", () => {
		expect(
			replyGateOutcome({ type: "redirect", note: "replacement" }, "original"),
		).toEqual({ approved: true, body: "replacement" });
	});

	it("rejects explicit reject actions", () => {
		expect(replyGateOutcome({ type: "action", key: "r" }, "original")).toEqual({
			approved: false,
			reason: "User rejected the thread reply.",
		});
	});
});

describe("resolveGateOutcome", () => {
	it("turns action annotations into steering rejections", () => {
		const result = resolveGateOutcome({
			type: "action",
			key: "a",
			note: "wait for CI first",
		});

		expect(result).toEqual({
			approved: false,
			reason: "User annotated: wait for CI first",
		});
	});

	it("rejects explicit reject actions", () => {
		expect(resolveGateOutcome({ type: "action", key: "r" })).toEqual({
			approved: false,
			reason: "User rejected the thread resolution.",
		});
	});

	it("approves unknown non-annotated actions", () => {
		expect(resolveGateOutcome({ type: "action", key: "x" })).toEqual({
			approved: true,
		});
	});
});
