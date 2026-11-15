import { beforeEach, describe, expect, it, vi } from "vitest";
import { route, slack } from "./routed.ts";

vi.mock("../../../lib/slack/index.ts", async (original) => ({
	...(await original<object>()),
	...(await import("./routed.ts")).slack,
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("searching", () => {
	it("searches everything when only an operator is given", async () => {
		await route("search_messages", { from: "@ada" });
		await route("search_files", { before: "2026-01-01", type: "pdfs" });

		expect(slack.searchMessages.mock.calls[0]?.slice(1)).toEqual([
			"*",
			{
				channel: undefined,
				from: "@ada",
				with: undefined,
				after: undefined,
				before: undefined,
				limit: undefined,
			},
		]);
		expect(slack.searchFiles.mock.calls[0]?.slice(1)).toEqual([
			"*",
			{
				channel: undefined,
				from: undefined,
				with: undefined,
				after: undefined,
				before: "2026-01-01",
				type: "pdfs",
				limit: undefined,
			},
		]);
	});

	it("searches within a channel by its name", async () => {
		await route("search_messages", { query: "deploy", channel: "C1" });

		expect(slack.searchMessages.mock.calls[0]?.[2]).toMatchObject({
			channel: "general",
		});
	});

	it("turns direct messages away from search, toward listing them", async () => {
		const dm = await route("search_messages", { query: "hi", channel: "D1" });
		const group = await route("search_files", { query: "hi", channel: "G1" });

		expect(dm.answer).toBe(
			"Slack search doesn't support DM conversations. " +
				"Use `list_messages` with the user ID as the channel instead.",
		);
		expect(group.answer).toContain("doesn't support group DM conversations.");
		expect(slack.searchMessages).not.toHaveBeenCalled();
		expect(slack.searchFiles).not.toHaveBeenCalled();
	});

	it("asks for a query when there is nothing to search by", async () => {
		expect((await route("search_messages", {})).answer).toBe(
			"Missing required parameter: query",
		);
		expect((await route("search_files", {})).answer).toBe(
			"Missing required parameter: query",
		);
	});
});

describe("listing messages", () => {
	it("reads a date as Slack's epoch seconds, and leaves a timestamp be", async () => {
		await route("list_messages", {
			channel: "C1",
			oldest: "2026-01-27T00:00:00Z",
			latest: "1769500000.000100",
			limit: 5,
		});

		expect(slack.listMessages.mock.calls[0]?.slice(2)).toEqual([
			{ limit: 5, oldest: "1769472000", latest: "1769500000.000100" },
		]);
	});

	it("passes a timestamp it can't read on to Slack", async () => {
		await route("list_messages", { channel: "C1", oldest: "last tuesday" });

		expect(slack.listMessages.mock.calls[0]?.[2]).toMatchObject({
			oldest: "last tuesday",
		});
	});
});

describe("routing", () => {
	it("names an action it doesn't know", async () => {
		expect((await route("delete_workspace", {})).answer).toBe(
			"Unknown action: delete_workspace",
		);
	});
});
