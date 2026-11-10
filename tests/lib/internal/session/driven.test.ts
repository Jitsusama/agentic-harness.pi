import { describe, expect, it } from "vitest";
import { automatedText } from "../../../../lib/internal/automated.ts";
import {
	isPersonWords,
	userTextOf,
} from "../../../../lib/internal/session/driven.ts";

const user = (content: unknown) => ({
	type: "message",
	message: { role: "user", content },
});

describe("userTextOf", () => {
	it("reads a user message's text, parts joined, and nothing else", () => {
		expect(userTextOf(user("hi"))).toBe("hi");
		expect(
			userTextOf(
				user([
					{ type: "text", text: "one" },
					{ type: "image", data: "…" },
					{ type: "text", text: "two" },
				]),
			),
		).toBe("one  two");
		expect(
			userTextOf({
				type: "message",
				message: { role: "assistant", content: "x" },
			}),
		).toBeUndefined();
		expect(
			userTextOf({ type: "custom_message", content: "hold" }),
		).toBeUndefined();
		expect(userTextOf("nonsense")).toBeUndefined();
	});
});

describe("isPersonWords", () => {
	it("counts what a person wrote, a lone dot included, and not what the harness said", () => {
		expect(isPersonWords(user("ship it")), "typed words").toBe(true);
		expect(isPersonWords(user(".")), "a lone dot").toBe(true);
		expect(
			isPersonWords(user(automatedText("background work", "j1 exited 0"))),
			"the harness's own turn",
		).toBe(false);
		expect(
			isPersonWords({
				type: "custom_message",
				customType: "mesh",
				content: "hi",
			}),
			"a peer's message",
		).toBe(false);
	});
});
