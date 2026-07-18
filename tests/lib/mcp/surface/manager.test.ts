import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Text } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { McpConnection } from "../../../../lib/mcp/connection.js";
import { defaultResolved } from "../../../../lib/mcp/frontend/defaults.js";
import { createFrontEndRegistry } from "../../../../lib/mcp/frontend/registry.js";
import { createSurfaceManager } from "../../../../lib/mcp/surface/manager.js";
import {
	defaultBackendOf,
	type SurfaceConfig,
} from "../../../../lib/mcp/surface/policy.js";
import type {
	McpServerConfig,
	McpTool,
	McpToolResult,
} from "../../../../lib/mcp/types.js";

const server: McpServerConfig = { id: "gw", url: "u" };
const ctx = {} as never;

function tool(name: string): McpTool {
	return {
		serverId: "gw",
		name,
		description: `${name} desc`,
		inputSchema: { type: "object" },
		raw: {},
	};
}

function config(overrides: Partial<SurfaceConfig> = {}): SurfaceConfig {
	return {
		include: [],
		exclude: [],
		progressive: [],
		direct: [],
		progressiveHints: {},
		autoProgressiveThreshold: 10,
		autoProgressive: true,
		...overrides,
	};
}

function fakeConnection(
	tools: McpTool[],
	call?: (name: string) => McpToolResult,
): McpConnection & { setTools(t: McpTool[]): void } {
	let current = tools;
	return {
		setTools(t) {
			current = t;
		},
		connect: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		listTools: vi.fn(async () => current),
		callTool: vi.fn(
			async (name: string): Promise<McpToolResult> =>
				call
					? call(name)
					: { content: [{ type: "text", text: `called ${name}` }] },
		),
		onToolsListChanged: vi.fn(() => () => {}),
	};
}

function manager(
	conn: McpConnection,
	cfg: () => SurfaceConfig,
	registry = createFrontEndRegistry({
		backendOf: defaultBackendOf,
		defaults: defaultResolved({ writeSignal: () => false }),
	}),
) {
	return createSurfaceManager({
		server,
		connection: conn,
		config: cfg,
		registry,
	});
}

describe("createSurfaceManager", () => {
	it("partitions direct, progressive, and disabled tools", async () => {
		const tools = [
			tool("slack_post"),
			tool("observe_query"),
			tool("secret_key"),
		];
		const conn = fakeConnection(tools);
		const m = manager(conn, () =>
			config({ progressive: ["observe"], exclude: ["secret_*"] }),
		);
		const delta = await m.reconcile();
		expect(delta.added.map((d) => d.name)).toEqual(["slack_post"]);
		expect(delta.progressiveHelpers.map((h) => h.name)).toContain(
			"gw_search_tools",
		);
		expect(m.catalog().map((e) => e.name)).toEqual([
			"observe_query",
			"slack_post",
		]);
	});

	it("keeps emitted names stable when tool order flips", async () => {
		const conn = fakeConnection([tool("alpha"), tool("beta")]);
		const m = createSurfaceManager({
			server: { id: "gw", url: "u", toolNamePrefix: "p_" },
			connection: conn,
			config: () => config(),
			registry: createFrontEndRegistry({
				backendOf: defaultBackendOf,
				defaults: defaultResolved({ writeSignal: () => false }),
			}),
		});
		await m.reconcile();
		const first = new Set(m.descriptors().map((d) => d.name));
		conn.setTools([tool("beta"), tool("alpha")]);
		await m.reconcile();
		expect(new Set(m.descriptors().map((d) => d.name))).toEqual(first);
		expect(first).toEqual(new Set(["p_alpha", "p_beta"]));
	});

	it("diffs added and removed across reconciles", async () => {
		const conn = fakeConnection([tool("slack_post")]);
		const m = manager(conn, () => config());
		await m.reconcile();
		conn.setTools([tool("slack_read")]);
		const delta = await m.reconcile();
		expect(delta.added.map((d) => d.name)).toEqual(["slack_read"]);
		expect(delta.removed).toEqual(["slack_post"]);
	});

	it("coalesces overlapping reconciles into a single flight", async () => {
		const conn = fakeConnection([tool("slack_post")]);
		const m = manager(conn, () => config());
		await Promise.all([m.reconcile(), m.reconcile(), m.reconcile()]);
		expect(
			(conn.listTools as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBeLessThanOrEqual(2);
	});

	it("dispatches a descriptor's execute through the connection and applies the shaper", async () => {
		const conn = fakeConnection([tool("slack_read")]);
		const registry = createFrontEndRegistry({
			backendOf: defaultBackendOf,
			defaults: defaultResolved({ writeSignal: () => false }),
		});
		registry.register({
			serverId: "gw",
			providerId: "p",
			match: { kind: "glob", pattern: "slack_*" },
			shape: () => [{ type: "text", text: "shaped" }],
		});
		const m = manager(conn, () => config(), registry);
		const [descriptor] = (await m.reconcile()).added;
		const result = await descriptor.execute(
			"id",
			{ a: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content).toEqual([{ type: "text", text: "shaped" }]);
		expect(conn.callTool).toHaveBeenCalledWith(
			"slack_read",
			{ a: 1 },
			{ signal: undefined },
		);
	});

	it("caps an oversized result through dispatch, regardless of shaper", async () => {
		const huge = "x".repeat(5000);
		const conn = fakeConnection([tool("observe_query")], () => ({
			content: [{ type: "text", text: huge }],
		}));
		const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "mgr-ceiling-"));
		const m = createSurfaceManager({
			server,
			connection: conn,
			config: () => config(),
			registry: createFrontEndRegistry({
				backendOf: defaultBackendOf,
				defaults: defaultResolved({ writeSignal: () => false }),
			}),
			resultCeiling: { limitBytes: 500, storageDir: () => storageDir },
		});
		const [descriptor] = (await m.reconcile()).added;
		const result = await descriptor.execute(
			"id",
			{},
			undefined,
			undefined,
			ctx,
		);
		const textBlocks = result.content.filter(
			(b): b is { type: "text"; text: string } => b.type === "text",
		);
		const totalBytes = textBlocks.reduce(
			(sum, b) => sum + Buffer.byteLength(b.text, "utf-8"),
			0,
		);
		expect(totalBytes).toBeLessThanOrEqual(500);
		expect(textBlocks.map((b) => b.text).join("\n")).toContain("Result capped");
		fs.rmSync(storageDir, { recursive: true, force: true });
	});

	it("caps an oversized result through the run_tool passthrough too", async () => {
		const huge = "x".repeat(5000);
		const conn = fakeConnection([tool("observe_query")], () => ({
			content: [{ type: "text", text: huge }],
		}));
		const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "mgr-pass-"));
		const m = createSurfaceManager({
			server,
			connection: conn,
			config: () => config({ progressive: ["observe"] }),
			registry: createFrontEndRegistry({
				backendOf: defaultBackendOf,
				defaults: defaultResolved({ writeSignal: () => false }),
			}),
			resultCeiling: { limitBytes: 500, storageDir: () => storageDir },
		});
		const runTool = (await m.reconcile()).progressiveHelpers[2];
		const result = await runTool.execute(
			"id",
			{ name: "observe_query", arguments: {} },
			undefined,
			undefined,
			ctx,
		);
		const totalBytes = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.reduce((sum, b) => sum + Buffer.byteLength(b.text, "utf-8"), 0);
		expect(totalBytes).toBeLessThanOrEqual(500);
		fs.rmSync(storageDir, { recursive: true, force: true });
	});

	it("throws from execute when the call errors", async () => {
		const conn = fakeConnection([tool("slack_read")], () => ({
			content: [{ type: "text", text: "boom" }],
			isError: true,
		}));
		const m = manager(conn, () => config());
		const [descriptor] = (await m.reconcile()).added;
		await expect(
			descriptor.execute("id", {}, undefined, undefined, ctx),
		).rejects.toThrow("boom");
	});

	const theme = {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		italic: (t: string) => t,
		underline: (t: string) => t,
		inverse: (t: string) => t,
		strikethrough: (t: string) => t,
	} as never;

	it("renders a progressive tool's result through its provider via the run-tool helper", async () => {
		const registry = createFrontEndRegistry({
			backendOf: defaultBackendOf,
			defaults: defaultResolved({ writeSignal: () => false }),
		});
		registry.register({
			serverId: "gw",
			providerId: "slack",
			match: { kind: "glob", pattern: "slack_*" },
			renderResult: () => new Text("PROVIDER-RENDER", 0, 0),
		});
		const conn = fakeConnection([tool("slack_read")]);
		const m = manager(
			conn,
			() => config({ progressive: ["slack_read"] }),
			registry,
		);
		const delta = await m.reconcile();
		const runTool = delta.progressiveHelpers.find(
			(d) => d.name === "gw_run_tool",
		);
		if (!runTool) throw new Error("run-tool helper missing");

		const proxied = runTool.renderResult(
			{ content: [{ type: "text", text: "body" }], details: undefined },
			{ expanded: false } as never,
			theme,
			{
				expanded: false,
				isPartial: false,
				isError: false,
				args: { name: "slack_read" },
				toolCallId: "t1",
			} as never,
		);
		expect(proxied.render(80).join("\n")).toContain("PROVIDER-RENDER");

		const plain = runTool.renderResult(
			{ content: [{ type: "text", text: "body" }], details: undefined },
			{ expanded: false } as never,
			theme,
			{
				expanded: false,
				isPartial: false,
				isError: false,
				args: { name: "unknown_tool" },
				toolCallId: "t2",
			} as never,
		);
		expect(plain.render(80).join("\n")).not.toContain("PROVIDER-RENDER");
	});
});
