import { describe, expect, it } from "vitest";
import { OUTCOME_GLYPH } from "../../../lib/ui/outcome-glyphs.ts";
import { confirmations, route, slack } from "./routed.ts";

describe("sending a thread", () => {
	it("posts the first message as its parent and replies under it", async () => {
		const { answer, result } = await route("send_thread", {
			channel: "C1",
			messages: [{ text: "parent" }, { text: "child" }],
		});

		expect(slack.sendMessage).toHaveBeenCalledWith(
			{},
			"C1",
			"parent",
			undefined,
		);
		expect(slack.replyToThread).toHaveBeenCalledWith(
			{},
			"C1",
			"9.9",
			"child",
			undefined,
		);
		expect(answer).toBe(
			"✓ Thread sent to #general (2 messages, parent ts: 9.9)",
		);
		expect(result.details).toEqual({ threadTs: "9.9" });
	});

	it("uploads a message's files with its text, its upload being the parent", async () => {
		await route("send_thread", {
			channel: "C1",
			messages: [
				{ text: "parent", file_paths: ["/tmp/a.png", "/tmp/a.png"] },
				{ text: "child" },
			],
		});

		expect(slack.uploadFiles).toHaveBeenCalledWith({}, ["/tmp/a.png"], {
			channelId: "C1",
			threadTs: undefined,
			initialComment: "parent",
		});
		expect(slack.replyToThread.mock.calls[0]?.[2]).toBe("8.8");
		expect(slack.sendMessage).not.toHaveBeenCalled();
	});

	it("sends a message's table after its text", async () => {
		await route("send_thread", {
			channel: "C1",
			messages: [
				{ text: "Team", table: { columns: ["Name"], rows: [["Ada"]] } },
			],
		});

		const blocks = slack.sendMessage.mock.calls[0]?.[3];
		expect(
			(blocks as { type: string }[] | undefined)?.map((block) => block.type),
		).toEqual(["rich_text", "table"]);
	});

	it("says how far it got when a message fails", async () => {
		slack.replyToThread.mockRejectedValueOnce(new Error("rate limited"));

		const { answer } = await route("send_thread", {
			channel: "C1",
			messages: [{ text: "parent" }, { text: "child" }],
		});

		expect(answer).toBe(
			`${OUTCOME_GLYPH.failed} thread failed at message 2 of 2: rate limited. ` +
				"1 message was already sent.",
		);
	});

	it("refuses a message it can't read, naming where", async () => {
		const missingText = await route("send_thread", {
			channel: "C1",
			messages: [{ text: "parent" }, { file_path: "/tmp/a.png" }],
		});
		const badTable = await route("send_thread", {
			channel: "C1",
			messages: [{ text: "parent", table: { columns: [], rows: [] } }],
		});
		const missingFile = await route("send_thread", {
			channel: "C1",
			messages: [{ text: "parent", file_path: "/tmp/missing.png" }],
		});

		expect(missingText.answer).toBe("Missing text in message at index 1.");
		expect(badTable.answer).toBe(
			"Message 1: Table must have at least one column.",
		);
		expect(missingFile.answer).toBe("File not found: /tmp/missing.png");
		expect(confirmations.confirmSendThread).not.toHaveBeenCalled();
		expect((await route("send_thread", { channel: "C1" })).answer).toBe(
			"Missing required parameter: messages",
		);
	});

	it("sends nothing when the person cancels", async () => {
		confirmations.confirmSendThread.mockResolvedValueOnce(null);

		const { answer } = await route("send_thread", {
			channel: "C1",
			messages: [{ text: "parent" }],
		});

		expect(answer).toBe(`${OUTCOME_GLYPH.cancelled} Send thread cancelled.`);
		expect(slack.sendMessage).not.toHaveBeenCalled();
	});
});

describe("queueing replies", () => {
	it("replies with every message under the thread it names", async () => {
		const { answer } = await route("reply_to_thread", {
			channel: "C1",
			ts: "1.5",
			messages: [{ text: "one" }, { text: "two" }],
		});

		expect(slack.replyToThread.mock.calls.map((call) => call[2])).toEqual([
			"1.5",
			"1.5",
		]);
		expect(slack.sendMessage).not.toHaveBeenCalled();
		expect(answer).toBe("✓ 2 replies sent in #general thread 1.5");
	});

	it("names the replies when the person cancels", async () => {
		confirmations.confirmSendThread.mockResolvedValueOnce(null);

		const { answer } = await route("reply_to_thread", {
			channel: "C1",
			ts: "1.5",
			messages: [{ text: "one" }],
		});

		expect(answer).toBe(`${OUTCOME_GLYPH.cancelled} Queued replies cancelled.`);
	});
});
