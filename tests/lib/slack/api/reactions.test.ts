/**
 * Reacting to a message: an emoji named with or without its colons
 * reaches Slack as the bare name it expects.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackClient } from "../../../../lib/slack/api/client.ts";
import {
	addReaction,
	removeReaction,
} from "../../../../lib/slack/api/reactions.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A Slack that takes every reaction, noting each ask. */
function slack(): string[] {
	const asked: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const { token: _token, ...params } = Object.fromEntries(
				new URLSearchParams(String(init?.body ?? "")),
			);
			asked.push(
				`${url.slice(url.lastIndexOf("/") + 1)} ${JSON.stringify(params)}`,
			);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
	return asked;
}

describe("reacting to a message", () => {
	it("adds and removes an emoji by its bare name, colons or not", async () => {
		const asked = slack();
		const client = new SlackClient("xoxp-1");

		await addReaction(client, "C1", "1.0", ":eyes:");
		await removeReaction(client, "C1", "1.0", "eyes");

		expect(asked).toEqual([
			'reactions.add {"channel":"C1","timestamp":"1.0","name":"eyes"}',
			'reactions.remove {"channel":"C1","timestamp":"1.0","name":"eyes"}',
		]);
	});
});
