/**
 * Posting to Slack: a message, a reply and an edit.
 *
 * Each says its mentions Slack's way, sends its blocks as JSON beside
 * the text that falls back for them, and hands back where the message
 * landed. Read off the requests the client makes, since that is all
 * Slack ever sees of them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackClient } from "../../../../lib/slack/api/client.ts";
import {
	editMessage,
	replyToThread,
	sendMessage,
} from "../../../../lib/slack/api/messages.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

interface Asked {
	readonly method: string;
	readonly params: Record<string, string>;
}

/** A Slack that places every message at C1, 2.0, and notes each ask. */
function slack(): Asked[] {
	const asked: Asked[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const { token: _token, ...params } = Object.fromEntries(
				new URLSearchParams(String(init?.body ?? "")),
			);
			asked.push({ method: url.slice(url.lastIndexOf("/") + 1), params });
			return new Response(
				JSON.stringify({ ok: true, channel: "C1", ts: "2.0" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}),
	);
	return asked;
}

const BLOCKS = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];

describe("posting to Slack", () => {
	it("sends a message with its mentions said Slack's way", async () => {
		const asked = slack();
		const client = new SlackClient("xoxp-1");

		const sent = await sendMessage(client, "C1", "hi @here");

		expect(sent).toEqual({ ok: true, channel: "C1", ts: "2.0" });
		expect(asked).toEqual([
			{
				method: "chat.postMessage",
				params: { channel: "C1", text: "hi <!here>" },
			},
		]);
	});

	it("sends a message's blocks as JSON beside its text", async () => {
		const asked = slack();
		const client = new SlackClient("xoxp-1");

		await sendMessage(client, "C1", "hi", BLOCKS);

		expect(asked[0]?.params).toEqual({
			channel: "C1",
			text: "hi",
			blocks: JSON.stringify(BLOCKS),
		});
	});

	it("replies in the thread it names", async () => {
		const asked = slack();
		const client = new SlackClient("xoxp-1");

		const sent = await replyToThread(client, "C1", "1.0", "hi @channel");

		expect(sent).toEqual({ ok: true, channel: "C1", ts: "2.0" });
		expect(asked).toEqual([
			{
				method: "chat.postMessage",
				params: { channel: "C1", text: "hi <!channel>", thread_ts: "1.0" },
			},
		]);
	});

	it("edits the message it names, blocks and all", async () => {
		const asked = slack();
		const client = new SlackClient("xoxp-1");

		const sent = await editMessage(client, "C1", "1.0", "hi @here", BLOCKS);

		expect(sent).toEqual({ ok: true, channel: "C1", ts: "2.0" });
		expect(asked).toEqual([
			{
				method: "chat.update",
				params: {
					channel: "C1",
					ts: "1.0",
					text: "hi <!here>",
					blocks: JSON.stringify(BLOCKS),
				},
			},
		]);
	});

	it("sends no blocks when it is given none", async () => {
		const asked = slack();
		const client = new SlackClient("xoxp-1");

		await replyToThread(client, "C1", "1.0", "hi");
		await editMessage(client, "C1", "1.0", "hi");

		expect(asked.map((ask) => "blocks" in ask.params)).toEqual([
			false,
			false,
		]);
	});
});
