import { describe, expect, it, vi } from "vitest";
import type { DiscoveryEntry } from "../../../../lib/mcp/render/tools-list.js";
import {
	createProgressiveHelpers,
	extractRunToolArguments,
	scoreToolName,
	searchTools,
} from "../../../../lib/mcp/surface/helpers.js";
import type { McpToolResult } from "../../../../lib/mcp/types.js";

function entry(
	name: string,
	backend: string,
	summary?: string,
): DiscoveryEntry {
	return { name, backend, mode: "progressive", summary };
}

const ctx = {} as never;

describe("scoreToolName", () => {
	it("returns a positive score only when all terms match somewhere", () => {
		const e = {
			name: "grokt_search_code",
			backend: "grokt",
			summary: "search the codebase",
		};
		expect(scoreToolName(e, ["search"])).toBeGreaterThan(0);
		expect(scoreToolName(e, ["search", "unrelated"])).toBe(0);
	});

	it("ranks a name-prefix match above a description-only match", () => {
		const prefix = { name: "search_all", backend: "x", summary: "" };
		const descOnly = { name: "zzz", backend: "x", summary: "search things" };
		expect(scoreToolName(prefix, ["search"])).toBeGreaterThan(
			scoreToolName(descOnly, ["search"]),
		);
	});
});

describe("searchTools", () => {
	it("ranks matches and applies the limit", () => {
		const entries = [
			entry("slack_post", "slack"),
			entry("slack_search", "slack"),
			entry("gws_docs", "gws"),
		];
		const ranked = searchTools(entries, "search", { limit: 5 });
		expect(ranked[0].name).toBe("slack_search");
	});

	it("returns everything (capped) for an empty query", () => {
		const entries = [entry("a_one", "a"), entry("b_two", "b")];
		expect(searchTools(entries, undefined, { limit: 1 })).toHaveLength(1);
	});
});

describe("extractRunToolArguments", () => {
	it("drops name and merges an object arguments field", () => {
		expect(
			extractRunToolArguments({
				name: "slack_post",
				arguments: { channel: "x" },
				extra: 1,
			}),
		).toEqual({
			extra: 1,
			channel: "x",
		});
	});

	it("parses a JSON-string arguments field", () => {
		expect(
			extractRunToolArguments({ name: "t", arguments: '{"a":2}' }),
		).toEqual({ a: 2 });
	});
});

describe("createProgressiveHelpers", () => {
	function helpers(
		runTool = vi.fn(
			async (): Promise<McpToolResult> => ({
				content: [{ type: "text", text: "ran" }],
			}),
		),
	) {
		const catalog = () => [
			entry("slack_post", "slack", "post a message"),
			entry("slack_read", "slack", "read"),
		];
		return {
			runTool,
			list: createProgressiveHelpers({
				namespace: "tool_gateway",
				catalog,
				hints: { slack: "Slack tools." },
				describe: (name) =>
					name === "slack_post" ? "slack_post — posts a message" : undefined,
				runTool,
			}),
		};
	}

	it("names the three helpers under the namespace", () => {
		expect(helpers().list.map((h) => h.name)).toEqual([
			"tool_gateway_search_tools",
			"tool_gateway_describe",
			"tool_gateway_run_tool",
		]);
	});

	it("search_tools returns a listing mentioning a matching tool", async () => {
		const search = helpers().list[0];
		const out = await search.run({ query: "post" }, ctx);
		expect(JSON.stringify(out.content)).toContain("slack_post");
	});

	it("describe returns the tool detail", async () => {
		const describe = helpers().list[1];
		const out = await describe.run({ name: "slack_post" }, ctx);
		expect(JSON.stringify(out.content)).toContain("posts a message");
	});

	it("run_tool rejects an unknown tool and does not dispatch", async () => {
		const { list, runTool } = helpers();
		const out = await list[2].run({ name: "nope" }, ctx);
		expect(out.isError).toBe(true);
		expect(runTool).not.toHaveBeenCalled();
	});

	it("run_tool dispatches a known tool with extracted args", async () => {
		const { list, runTool } = helpers();
		await list[2].run({ name: "slack_post", arguments: { channel: "x" } }, ctx);
		expect(runTool).toHaveBeenCalledWith("slack_post", { channel: "x" }, ctx);
	});
});
