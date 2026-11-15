/**
 * A Slack tool action run through the router against fakes.
 *
 * Importing this mocks the Slack client and the confirmation gates
 * with `slack` and `confirmations` from here, so the router's own
 * work shows: what it asks Slack for, what it sends and what it
 * answers. Every gate approves unless a test says otherwise, and each
 * test starts with no calls recorded. The mocks hold because `route`
 * imports the router only after they're in place.
 */

import { beforeEach, vi } from "vitest";
import type { ActionParams, ToolResult } from "../../../lib/slack/types.ts";
import { resultSession } from "../../support/result-session.ts";

vi.mock("../../../lib/slack/index.ts", async (original) => ({
	...(await original<object>()),
	...(await import("./routed.ts")).slack,
}));
vi.mock(
	"../../../extensions/slack-integration/confirmation.ts",
	async (original) => ({
		...(await original<object>()),
		...(await import("./routed.ts")).confirmations,
	}),
);

beforeEach(() => {
	vi.clearAllMocks();
});

/** A conversation as the fake resolver names it. */
function conversation(id: string) {
	const kind = id.startsWith("D")
		? "dm"
		: id.startsWith("G")
			? "group_dm"
			: "channel";
	return { id, kind, name: "general", displayName: "#general" };
}

/** What a send, reply or edit gives back. */
const POSTED = { ok: true, channel: "C1", ts: "9.9" };

/** The Slack client calls the router reaches, faked. */
export const slack = {
	resolveConversation: vi.fn(async (_client: unknown, id: string) =>
		conversation(id),
	),
	resolveTarget: vi.fn(
		async (
			_client: unknown,
			_target?: string,
			channel?: string,
			ts?: string,
		) => ({ conversation: conversation(channel ?? "C1"), ts: ts ?? "1.0" }),
	),
	resolveUser: vi.fn(async (_client: unknown, user: string) => user),
	resolveMessages: vi.fn(async () => undefined),
	formatMentions: vi.fn(async (_client: unknown, text: string) => text),
	searchMessages: vi.fn(
		async (_client: unknown, query: string, _options: unknown) => ({
			messages: [],
			total: 0,
			query,
		}),
	),
	searchFiles: vi.fn(
		async (_client: unknown, query: string, _options: unknown) => ({
			files: [],
			total: 0,
			query,
		}),
	),
	listMessages: vi.fn(
		async (_client: unknown, _conversation: unknown, _options: unknown) => [],
	),
	sendMessage: vi.fn(
		async (
			_client: unknown,
			_channel: string,
			_text: string,
			_blocks?: unknown,
		) => POSTED,
	),
	replyToThread: vi.fn(
		async (
			_client: unknown,
			_channel: string,
			_ts: string,
			_text: string,
			_blocks?: unknown,
		) => POSTED,
	),
	editMessage: vi.fn(
		async (
			_client: unknown,
			_channel: string,
			_ts: string,
			_text: string,
			_blocks?: unknown,
		) => POSTED,
	),
	addReaction: vi.fn(
		async (_client: unknown, _channel: string, _ts: string, _emoji: string) =>
			undefined,
	),
	removeReaction: vi.fn(
		async (_client: unknown, _channel: string, _ts: string, _emoji: string) =>
			undefined,
	),
	uploadFiles: vi.fn(
		async (_client: unknown, _paths: string[], _options: unknown) => ({
			ts: "8.8",
			files: [],
		}),
	),
	getFileSize: vi.fn(async (path: string) => {
		if (path.includes("missing")) throw new Error("ENOENT");
		return 10;
	}),
};

/** A gate's approval of the text it was shown. */
function approved(text: string): unknown {
	return { approved: true, data: { text } };
}

/** A gate that approves without data to carry. */
function approves() {
	return vi.fn(async (): Promise<unknown> => ({ approved: true, data: true }));
}

/** The confirmation gates the router asks, faked. */
export const confirmations = {
	confirmSendMessage: vi.fn(
		async (_ctx: unknown, _name: string, text: string) => approved(text),
	),
	confirmReply: vi.fn(
		async (_ctx: unknown, _name: string, _ts: string, text: string) =>
			approved(text),
	),
	confirmEditMessage: vi.fn(
		async (_ctx: unknown, _name: string, _ts: string, text: string) =>
			approved(text),
	),
	confirmReaction: approves(),
	confirmUploadFile: approves(),
	confirmSendThread: approves(),
};

/** Run one action through the router, answering with its text. */
export async function route(
	action: string,
	params: ActionParams,
): Promise<{ answer: string; result: ToolResult }> {
	const { routeAction } = await import(
		"../../../extensions/slack-integration/router.ts"
	);
	const result = await routeAction(
		action,
		{} as never,
		params,
		{ ...resultSession(), hasUI: false } as never,
		{ readSignatures: () => [], persistSignature: () => undefined },
	);
	const first = result.content[0];
	return { answer: first?.type === "text" ? first.text : "", result };
}
