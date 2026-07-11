import { describe, expect, it } from "vitest";
import {
	formatSlackText,
	renderMessageList,
} from "../../../../lib/slack/renderers/message.js";

describe("formatSlackText", () => {
	it("translates a labelled user mention to an at-name", () => {
		expect(formatSlackText("<@U1|joel> shipped it")).toBe("@joel shipped it");
	});

	it("translates a labelled channel link to a hash-name", () => {
		expect(formatSlackText("see <#C1|general>")).toBe("see #general");
	});

	it("translates a labelled url link to markdown", () => {
		expect(formatSlackText("<https://example.com|site>")).toBe(
			"[site](https://example.com)",
		);
	});

	it("translates a bare url link to its address", () => {
		expect(formatSlackText("<https://example.com>")).toBe(
			"https://example.com",
		);
	});

	it("translates a here broadcast to an at-here", () => {
		expect(formatSlackText("<!here> standup")).toBe("@here standup");
	});
});

describe("renderMessageList", () => {
	it("reports the empty state when there are no messages", () => {
		expect(renderMessageList([])).toBe("No messages found.");
	});
});
