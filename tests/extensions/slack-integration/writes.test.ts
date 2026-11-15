import { describe, expect, it } from "vitest";
import { OUTCOME_GLYPH } from "../../../lib/ui/outcome-glyphs.ts";
import { confirmations, route, slack } from "./routed.ts";

/** The blocks a call sent, as its last argument. */
function blocksOf(call: unknown[] | undefined): unknown[] | undefined {
	const blocks = call?.at(-1);
	return Array.isArray(blocks) ? blocks : undefined;
}

/** The type of each block sent. */
function typesOf(blocks: unknown[] | undefined): unknown[] | undefined {
	return blocks?.map((block) => (block as { type?: unknown }).type);
}

const TABLE = { columns: ["Name", "Role"], rows: [["Ada", "Lead"]] };

describe("sending a message", () => {
	it("sends plain text as text alone", async () => {
		const { answer } = await route("send_message", {
			channel: "C1",
			text: "hello there",
		});

		expect(slack.sendMessage).toHaveBeenCalledWith(
			{},
			"C1",
			"hello there",
			undefined,
		);
		expect(answer).toBe("✓ Message sent to #general (ts: 9.9)");
	});

	it("sends a list as rich text blocks", async () => {
		await route("send_message", { channel: "C1", text: "Plan:\n- one\n- two" });

		expect(typesOf(blocksOf(slack.sendMessage.mock.calls[0]))).toContain(
			"rich_text",
		);
	});

	it("puts the text ahead of a table, and names a table sent alone", async () => {
		await route("send_message", { channel: "C1", text: "Team", table: TABLE });
		await route("send_message", { channel: "C1", table: TABLE });

		const [withText, alone] = slack.sendMessage.mock.calls;
		expect(typesOf(blocksOf(withText))).toEqual(["rich_text", "table"]);
		expect(alone?.[2]).toBe("Table with 1 rows");
		expect(typesOf(blocksOf(alone))).toEqual(["table"]);
	});

	it("refuses a table Slack can't draw, sending nothing", async () => {
		const { answer } = await route("send_message", {
			channel: "C1",
			table: { columns: ["A", "B"], rows: [["only one"]] },
		});

		expect(answer).toBe("Row 1 has 1 cells but table has 2 columns.");
		expect(slack.sendMessage).not.toHaveBeenCalled();
	});

	it("uploads attached files with the text as their comment", async () => {
		const { answer } = await route("send_message", {
			channel: "C1",
			text: "see attached",
			file_path: "/tmp/a.png",
			file_paths: ["/tmp/a.png", "/tmp/b.txt"],
		});

		expect(slack.uploadFiles).toHaveBeenCalledWith(
			{},
			["/tmp/a.png", "/tmp/b.txt"],
			{ channelId: "C1", threadTs: undefined, initialComment: "see attached" },
		);
		expect(answer).toBe("✓ Uploaded a.png, b.txt to #general");
		expect(slack.sendMessage).not.toHaveBeenCalled();
	});

	it("names a file it can't find, uploading nothing", async () => {
		const { answer } = await route("upload_file", {
			channel: "C1",
			file_path: "/tmp/missing.png",
		});

		expect(answer).toBe("File not found: /tmp/missing.png");
		expect(slack.uploadFiles).not.toHaveBeenCalled();
	});

	it("asks for what it lacks", async () => {
		expect((await route("send_message", { text: "hi" })).answer).toBe(
			"Missing required parameter: channel",
		);
		expect((await route("send_message", { channel: "C1" })).answer).toBe(
			"Missing required parameter: text",
		);
		expect((await route("upload_file", { channel: "C1" })).answer).toBe(
			"Missing required parameter: file_path or file_paths",
		);
	});

	it("sends nothing the person cancels or turns back", async () => {
		confirmations.confirmSendMessage.mockResolvedValueOnce(null);
		confirmations.confirmSendMessage.mockResolvedValueOnce({
			approved: false,
			redirect: "Say it gentler.",
		});

		const cancelled = await route("send_message", { channel: "C1", text: "hi" });
		const redirected = await route("send_message", {
			channel: "C1",
			text: "hi",
		});

		expect(cancelled.answer).toBe(
			`${OUTCOME_GLYPH.cancelled} Send message cancelled.`,
		);
		expect(redirected.answer).toBe("Say it gentler.");
		expect(slack.sendMessage).not.toHaveBeenCalled();
	});
});

describe("replying to a thread", () => {
	it("replies under the message it names", async () => {
		const { answer } = await route("reply_to_thread", {
			channel: "C1",
			ts: "1.5",
			text: "on it",
		});

		expect(slack.replyToThread).toHaveBeenCalledWith(
			{},
			"C1",
			"1.5",
			"on it",
			undefined,
		);
		expect(answer).toBe("✓ Reply sent in thread 1.5 (ts: 9.9)");
	});

	it("puts the text ahead of a table", async () => {
		await route("reply_to_thread", {
			channel: "C1",
			ts: "1.5",
			text: "Team",
			table: TABLE,
		});

		expect(typesOf(blocksOf(slack.replyToThread.mock.calls[0]))).toEqual([
			"rich_text",
			"table",
		]);
	});

	it("uploads attached files into the thread", async () => {
		await route("reply_to_thread", {
			channel: "C1",
			ts: "1.5",
			file_path: "/tmp/a.png",
		});

		expect(slack.uploadFiles).toHaveBeenCalledWith({}, ["/tmp/a.png"], {
			channelId: "C1",
			threadTs: "1.5",
			initialComment: undefined,
		});
	});

	it("won't mix queued replies with a single reply's text", async () => {
		const { answer } = await route("reply_to_thread", {
			channel: "C1",
			ts: "1.5",
			text: "one",
			messages: [{ text: "two" }],
		});

		expect(answer).toContain("Cannot combine `messages` with `text`");
		expect(slack.replyToThread).not.toHaveBeenCalled();
	});
});

describe("editing a message", () => {
	it("rewrites its text and table", async () => {
		const { answer } = await route("edit_message", {
			channel: "C1",
			ts: "1.5",
			text: "Team",
			table: TABLE,
		});

		const [call] = slack.editMessage.mock.calls;
		expect(call?.slice(1, 4)).toEqual(["C1", "1.5", "Team"]);
		expect(typesOf(blocksOf(call))).toEqual(["rich_text", "table"]);
		expect(answer).toBe("✓ Message edited in #general (ts: 9.9)");
	});

	it("won't change a message's files", async () => {
		const { answer } = await route("edit_message", {
			channel: "C1",
			ts: "1.5",
			text: "Team",
			file_path: "/tmp/a.png",
		});

		expect(answer).toContain("edit_message cannot change file attachments.");
		expect(slack.editMessage).not.toHaveBeenCalled();
	});
});

describe("reacting", () => {
	it("adds and removes an emoji on the message it names", async () => {
		const added = await route("add_reaction", {
			channel: "C1",
			ts: "1.5",
			emoji: "tada",
		});
		const removed = await route("remove_reaction", {
			channel: "C1",
			ts: "1.5",
			emoji: "tada",
		});

		expect(slack.addReaction).toHaveBeenCalledWith({}, "C1", "1.5", "tada");
		expect(slack.removeReaction).toHaveBeenCalledWith({}, "C1", "1.5", "tada");
		expect(added.answer).toBe("✓ Added :tada: reaction");
		expect(removed.answer).toBe("✓ Removed :tada: reaction");
	});

	it("says which reaction change was cancelled", async () => {
		confirmations.confirmReaction.mockResolvedValueOnce(null);
		confirmations.confirmReaction.mockResolvedValueOnce(null);

		const added = await route("add_reaction", {
			channel: "C1",
			ts: "1.5",
			emoji: "tada",
		});
		const removed = await route("remove_reaction", {
			channel: "C1",
			ts: "1.5",
			emoji: "tada",
		});

		expect(added.answer).toBe(`${OUTCOME_GLYPH.cancelled} Reaction cancelled.`);
		expect(removed.answer).toBe(
			`${OUTCOME_GLYPH.cancelled} Reaction removal cancelled.`,
		);
		const bare = await route("add_reaction", { channel: "C1", ts: "1.5" });
		expect(bare.answer).toBe("Missing required parameter: emoji");
	});
});
