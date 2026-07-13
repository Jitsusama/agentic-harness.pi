import { describe, expect, it } from "vitest";
import { describeCall } from "../../../../lib/mcp/render/call.js";
import type { McpTool } from "../../../../lib/mcp/types.js";

function tool(name: string, schema: McpTool["inputSchema"]): McpTool {
	return { serverId: "s", name, description: "", inputSchema: schema, raw: {} };
}

describe("describeCall", () => {
	it("uses the tool name as the title", () => {
		const view = describeCall(tool("slack_post", { type: "object" }), {});
		expect(view.toolTitle).toBe("slack_post");
	});

	it("picks the first required string arg as the primary", () => {
		const t = tool("slack_post", {
			type: "object",
			properties: {
				channel: { type: "string" },
				count: { type: "number" },
				text: { type: "string" },
			},
			required: ["count", "text"],
		});
		const view = describeCall(t, {
			count: 3,
			text: "hello",
			channel: "general",
		});
		expect(view.primaryArg).toEqual({ name: "text", value: "hello" });
	});

	it("falls back to a conventional arg name when no required string exists", () => {
		const t = tool("grokt_search", {
			type: "object",
			properties: { query: { type: "string" } },
		});
		const view = describeCall(t, { limit: 10, query: "needle" });
		expect(view.primaryArg).toEqual({ name: "query", value: "needle" });
	});

	it("truncates a long primary value to 40 characters with an ellipsis", () => {
		const t = tool("q", {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
		const long = "x".repeat(60);
		const view = describeCall(t, { query: long });
		expect(view.primaryArg?.value).toHaveLength(40);
		expect(view.primaryArg?.value.endsWith("…")).toBe(true);
	});

	it("counts the args beyond the primary", () => {
		const t = tool("q", {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
		const view = describeCall(t, { query: "a", limit: 1, sort: "asc" });
		expect(view.extraArgCount).toBe(2);
	});

	it("reports no primary and the full count when nothing matches", () => {
		const t = tool("ping", { type: "object" });
		const view = describeCall(t, { a: 1, b: 2 });
		expect(view.primaryArg).toBeUndefined();
		expect(view.extraArgCount).toBe(2);
	});

	it("adds a server prefix only when more than one server is mounted", () => {
		const t = tool("slack_post", { type: "object" });
		expect(
			describeCall(t, {}, { multiServer: false }).serverPrefix,
		).toBeUndefined();
		expect(
			describeCall(t, {}, { multiServer: true, serverLabel: "gw" })
				.serverPrefix,
		).toBe("gw");
	});
});
