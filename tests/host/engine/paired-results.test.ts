/** A request's tool results beside their calls, whatever pi's session wrote between them. */
import { describe, expect, it } from "vitest";
import { pairToolResults } from "../../../host/engine/paired-results.ts";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";

const user = (text: string): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text }],
});
const peer = (text: string): AgentMessage => ({
	role: "custom",
	customType: "mesh",
	content: text,
});
const answer = (...ids: string[]): AgentMessage => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall", id, name: "bash" })),
	stopReason: "toolUse",
});
const result = (id: string, text = `ran ${id}`): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text }],
	isError: false,
});

describe("a request's tool results", () => {
	it("are left as they are when each follows its call", () => {
		const messages = [user("go"), answer("a", "b"), result("a"), result("b")];
		expect(pairToolResults(messages)).toEqual(messages);
	});

	it("follow their call when a message was written between them, which then follows the results", () => {
		// As on 13 November: a mesh message written mid-round, between a call and its result.
		const word = peer("a word from a peer");
		expect(
			pairToolResults([
				user("go"),
				answer("a"),
				word,
				result("a"),
				user("next"),
			]),
		).toEqual([user("go"), answer("a"), result("a"), word, user("next")]);
	});

	it("are gathered from either side of what was written among several", () => {
		const word = peer("between");
		expect(
			pairToolResults([answer("a", "b"), result("a"), word, result("b")]),
		).toEqual([answer("a", "b"), result("a"), result("b"), word]);
	});

	it("stay apart from the next answer's calls", () => {
		const messages = [
			answer("a"),
			user("interrupted"),
			answer("b"),
			result("a"),
			result("b"),
		];
		const paired = pairToolResults(messages);
		expect(paired.slice(0, 4)).toEqual([
			answer("a"),
			user("interrupted"),
			answer("b"),
			result("b"),
		]);
		expect(paired.map((message) => message.role)).toEqual([
			"assistant",
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
	});

	it("become the person's text, saying so, when their call is not before them", () => {
		const paired = pairToolResults([user("go"), result("gone", "the output")]);
		expect(paired.map((message) => message.role)).toEqual(["user", "user"]);
		expect(JSON.stringify(paired[1])).toContain("call gone");
		expect(JSON.stringify(paired[1])).toContain("the output");
	});

	it("are given once, a second result for one call becoming text", () => {
		const paired = pairToolResults([answer("a"), result("a"), result("a")]);
		expect(paired.map((message) => message.role)).toEqual([
			"assistant",
			"toolResult",
			"user",
		]);
	});
});
