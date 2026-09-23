import { describe, expect, it } from "vitest";
import {
	IMAGE_CHARS,
	sizeOf,
} from "../../../extensions/demote-workflow/size.js";

describe("sizing a message by what it puts in the prompt", () => {
	it("counts a tool result's text and names it", () => {
		const sized = sizeOf({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [
				{ type: "text", text: "abc" },
				{ type: "text", text: "de" },
			],
		});
		expect(sized).toEqual({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			chars: 5,
		});
	});

	it("counts an image at its fixed estimate, since it is billed by pixels", () => {
		const sized = sizeOf({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [
				{ type: "image", data: "x".repeat(900_000), mimeType: "image/png" },
			],
		});
		expect(sized.chars).toBe(IMAGE_CHARS);
	});

	it("counts an assistant's text and tool calls but not its thinking", () => {
		// The provider strips earlier turns' thinking from the prompt, so it
		// is not part of the suffix a demotion would re-write.
		const sized = sizeOf({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "x".repeat(10_000) },
				{ type: "text", text: "hello" },
				{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { command: "ls" },
				},
			],
		});
		expect(sized.chars).toBe(
			"hello".length + "bash".length + JSON.stringify({ command: "ls" }).length,
		);
	});

	it("counts a user message given as a plain string", () => {
		expect(sizeOf({ role: "user", content: "hi there" }).chars).toBe(8);
	});

	it("counts a summary by its text", () => {
		expect(sizeOf({ role: "compactionSummary", summary: "abcd" }).chars).toBe(
			4,
		);
	});

	it("counts a hand-run command and its output, unless it was kept out of context", () => {
		expect(
			sizeOf({ role: "bashExecution", command: "ls", output: "a b" }).chars,
		).toBe(5);
		expect(
			sizeOf({
				role: "bashExecution",
				command: "ls",
				output: "a b",
				excludeFromContext: true,
			}).chars,
		).toBe(0);
	});
});
