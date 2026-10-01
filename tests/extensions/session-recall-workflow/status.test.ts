import { describe, expect, it } from "vitest";
import { RECALL_NOTE } from "../../../extensions/session-recall-workflow/index.ts";
import { recallSection } from "../../../extensions/session-recall-workflow/status.ts";

const called = {
	type: "message",
	message: {
		role: "assistant",
		content: [
			{ type: "text", text: "Let me look." },
			{ type: "toolCall", name: "session_recall", arguments: {} },
			{ type: "toolCall", name: "bash", arguments: {} },
		],
	},
};

describe("recall's status", () => {
	it("says whether summaries mention the tool and whether it was called", () => {
		const branch = [
			{ type: "compaction", summary: `summary${RECALL_NOTE}` },
			{ type: "compaction", summary: "summary from before the note" },
			called,
		];

		expect(recallSection(true, RECALL_NOTE, branch).lines).toEqual([
			"session_recall: active",
			"summaries that mention it: 1 of 2",
			"calls on this branch: 1",
		]);
	});

	it("tells inactive apart from a pi that cannot say", () => {
		expect(recallSection(false, RECALL_NOTE, []).lines[0]).toBe(
			"session_recall: registered but not active",
		);
		expect(recallSection(undefined, RECALL_NOTE, []).lines[0]).toMatch(
			/cannot say/,
		);
	});
});
