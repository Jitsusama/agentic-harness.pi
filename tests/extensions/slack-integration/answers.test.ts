import { describe, expect, it } from "vitest";
import { answered } from "../../../extensions/slack-integration/confirmation.ts";

const CONTEXT = "Send message to #general";

describe("a Slack gate's answer", () => {
	it("approves a plain Enter with what was asked about", () => {
		expect(
			answered({ type: "action", key: "enter" }, CONTEXT, { text: "hi" }),
		).toEqual({ approved: true, data: { text: "hi" } });
	});

	it("is nothing when the person cancels", () => {
		expect(answered(null, CONTEXT, true), "cancelled").toBeNull();
	});

	it("sends the agent back with the person's note on Enter", () => {
		const answer = answered(
			{ type: "action", key: "enter", note: "say it in French" },
			CONTEXT,
			true,
		);
		expect(answer, "a noted Enter is a redirect").toMatchObject({
			approved: false,
		});
		expect(JSON.stringify(answer)).toContain("say it in French");
		expect(JSON.stringify(answer)).toContain("#general");
	});

	it("says the person rejected it when they gave no reason", () => {
		const answer = answered({ type: "action", key: "r" }, CONTEXT, true);
		expect(JSON.stringify(answer), "the bare rejection").toContain(
			"User rejected. Ask for guidance.",
		);
	});

	it("keeps the person's reason for a rejection", () => {
		const answer = answered(
			{ type: "action", key: "r", note: "not this channel" },
			CONTEXT,
			true,
		);
		expect(JSON.stringify(answer), "the rejection's note").toContain(
			"not this channel",
		);
		expect(JSON.stringify(answer)).not.toContain("Ask for guidance");
	});

	it("follows a redirect with its note", () => {
		const answer = answered(
			{ type: "redirect", note: "use the thread" },
			CONTEXT,
			true,
		);
		expect(answer, "a redirect").toMatchObject({ approved: false });
		expect(JSON.stringify(answer)).toContain("use the thread");
	});
});
