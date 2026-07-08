import { describe, expect, it } from "vitest";
import { entriesToTurns } from "../../../extensions/correction-capture/transcript.js";

describe("entriesToTurns", () => {
	it("keeps user and assistant messages with text", () => {
		const turns = entriesToTurns([
			{ type: "message", message: { role: "user", content: "do X" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "ok" },
						{ type: "tool_use", text: undefined },
					],
				},
			},
		]);
		expect(turns).toEqual([
			{ role: "user", text: "do X" },
			{ role: "assistant", text: "ok" },
		]);
	});

	it("drops non-message entries and empty text", () => {
		const turns = entriesToTurns([
			{ type: "model_change" },
			{ type: "message", message: { role: "user", content: "   " } },
			{ type: "message", message: { role: "system", content: "x" } },
		]);
		expect(turns).toEqual([]);
	});
});
