import { describe, expect, it, vi } from "vitest";
import {
	createMcpConnection,
	mcpErrorFrom,
	type SdkClientLike,
} from "../../../lib/mcp/connection.js";
import { McpError, type McpServerConfig } from "../../../lib/mcp/types.js";

const config: McpServerConfig = { id: "gw", url: "https://example/mcp" };

/** A fake SDK client that records requests and exposes the notification handler for triggering. */
function fakeClient(responses: {
	toolsList?: unknown;
	call?: unknown;
	callThrows?: unknown;
}): SdkClientLike & {
	notify(): void;
} {
	let notifyHandler: () => void = () => {};
	return {
		connect: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		setNotificationHandler(_schema: unknown, handler: () => void) {
			notifyHandler = handler;
		},
		async request(request: { method: string }) {
			if (request.method === "tools/list") return responses.toolsList;
			if (request.method === "tools/call") {
				if (responses.callThrows) throw responses.callThrows;
				return responses.call;
			}
			throw new Error(`unexpected method ${request.method}`);
		},
		notify() {
			notifyHandler();
		},
	};
}

describe("mcpErrorFrom", () => {
	it("maps an HTTP status into status", () => {
		const err = mcpErrorFrom({ code: 401, message: "unauthorized" });
		expect(err).toBeInstanceOf(McpError);
		expect(err.status).toBe(401);
		expect(err.code).toBeUndefined();
	});

	it("maps a JSON-RPC code into code", () => {
		const err = mcpErrorFrom({ code: -32001, message: "auth" });
		expect(err.code).toBe(-32001);
		expect(err.status).toBeUndefined();
	});

	it("passes an existing McpError through", () => {
		const original = new McpError("x", { status: 429 });
		expect(mcpErrorFrom(original)).toBe(original);
	});
});

describe("createMcpConnection", () => {
	it("lists tools and preserves annotations and non-standard fields in raw", async () => {
		const client = fakeClient({
			toolsList: {
				tools: [
					{
						name: "slack_post",
						description: "post",
						inputSchema: { type: "object" },
						annotations: { readOnlyHint: false },
						surface: { kind: "draft" },
					},
				],
			},
		});
		const conn = createMcpConnection(config, { client, transport: {} });
		await conn.connect();
		const [tool] = await conn.listTools();
		expect(tool.serverId).toBe("gw");
		expect(tool.annotations).toEqual({ readOnlyHint: false });
		expect(tool.raw.surface).toEqual({ kind: "draft" });
	});

	it("maps a call result into content and the error flag", async () => {
		const client = fakeClient({
			call: { content: [{ type: "text", text: "done" }], isError: false },
		});
		const conn = createMcpConnection(config, { client, transport: {} });
		await conn.connect();
		const result = await conn.callTool("slack_post", { a: 1 });
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		expect(result.isError).toBe(false);
	});

	it("surfaces a transport failure as an errored result carrying the status", async () => {
		const client = fakeClient({
			callThrows: { code: 401, message: "unauthorized" },
		});
		const conn = createMcpConnection(config, { client, transport: {} });
		await conn.connect();
		const result = await conn.callTool("slack_post", {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("unauthorized");
		expect(
			(result._meta as { transportError?: { status?: number } })?.transportError
				?.status,
		).toBe(401);
	});

	it("fans a tools-list-changed notification out to subscribers", async () => {
		const client = fakeClient({});
		const conn = createMcpConnection(config, { client, transport: {} });
		await conn.connect();
		const a = vi.fn();
		const b = vi.fn();
		conn.onToolsListChanged(a);
		const offB = conn.onToolsListChanged(b);
		offB();
		client.notify();
		expect(a).toHaveBeenCalledOnce();
		expect(b).not.toHaveBeenCalled();
	});
});
