import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	describeCall,
	renderDefaultCall,
} from "../../../../lib/mcp/render/call.ts";
import type { McpTool } from "../../../../lib/mcp/types.ts";
import { fakeTheme } from "../../ui/fake-theme.ts";

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

	it("keeps the whole primary value, leaving the clip to the call line", () => {
		const t = tool("q", {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
		const long = "x".repeat(60);
		expect(describeCall(t, { query: long }).primaryArg?.value).toBe(long);
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

/**
 * A gateway's tool reads as every other tool's call does: the tool bold
 * as the anchor, then what it was pointed at and anything else dim.
 */
describe("the default call line", () => {
	const search = tool("grokt_search", {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	});
	const drawn = (
		args: Record<string, unknown>,
		opts: { multiServer?: boolean; serverLabel?: string } = {},
		reuse?: unknown,
	) => renderDefaultCall(search, args, fakeTheme(), opts, reuse);
	const text = (component: unknown) =>
		(component as Text).render(400).join("").trimEnd();

	it("draws the tool bold, then the subject and notes dim", () => {
		expect(
			text(
				drawn(
					{ query: "needle", limit: 1 },
					{ multiServer: true, serverLabel: "gw" },
				),
			),
		).toBe(
			"<toolTitle><b>grokt_search</b></toolTitle><dim> needle</dim><dim> +1 arg</dim><dim> on gw</dim>",
		);
	});

	it("clips its subject where every other call line does", () => {
		const shown = text(drawn({ query: "x".repeat(80) }));
		expect(shown).toContain(`${"x".repeat(59)}\u2026`);
		expect(shown).not.toContain("x".repeat(60));
	});

	it("redraws into the component pi hands back", () => {
		const first = drawn({ query: "one" });
		const second = drawn({ query: "two" }, {}, first);
		expect(second).toBe(first);
		expect(text(second)).toContain("two");
		expect(first).toBeInstanceOf(Text);
	});
});
