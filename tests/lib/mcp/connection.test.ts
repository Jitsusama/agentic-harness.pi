import { describe, expect, it, vi } from "vitest";
import {
	createMcpConnection,
	mcpErrorFrom,
	type SdkClientLike,
} from "../../../lib/mcp/connection.ts";
import { defaultWriteSignal } from "../../../lib/mcp/frontend/defaults.ts";
import { McpError, type McpServerConfig } from "../../../lib/mcp/types.ts";

const config: McpServerConfig = { id: "gw", url: "https://example/mcp" };

/** Which of the SDK's modules and zod have loaded since the set was cleared. */
const sdk = vi.hoisted(() => {
	const loaded = new Set<string>();
	const watch =
		(name: string) =>
		async (original: () => Promise<unknown>): Promise<unknown> => {
			loaded.add(name);
			return await original();
		};
	return { loaded, watch };
});
const WATCHED = ["client", "streamableHttp", "types", "zod"];
vi.mock("@modelcontextprotocol/sdk/client/index.js", sdk.watch("client"));
vi.mock(
	"@modelcontextprotocol/sdk/client/streamableHttp.js",
	sdk.watch("streamableHttp"),
);
vi.mock("@modelcontextprotocol/sdk/types.js", sdk.watch("types"));
vi.mock("zod", sdk.watch("zod"));

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
	// The SDK and zod hold about 12 MB of heap once imported, and a session
	// whose cached tool list stands in may never connect. The case loads the
	// library's barrel afresh, as a session does, so its connect pays the
	// SDK's first import: on a busy machine that outlasts five seconds.
	it("loads neither the SDK nor zod until a connection opens", {
		timeout: 30_000,
	}, async () => {
		vi.resetModules();
		sdk.loaded.clear();
		const mcp = await import("../../../lib/mcp/index.ts");
		const unused = mcp.createMcpConnection(config);
		await unused.close();
		const conn = mcp.createMcpConnection(config, {
			client: fakeClient({}),
			transport: {},
		});
		await vi.dynamicImportSettled();
		expect(
			[...sdk.loaded],
			"loaded by importing the library, creating or closing",
		).toEqual([]);
		await conn.connect();
		expect([...sdk.loaded].sort(), "loaded by connecting").toEqual(WATCHED);
	});

	it("refuses a url that isn't one when the connection is created", () => {
		expect(() => createMcpConnection({ id: "gw", url: "not a url" })).toThrow(
			"MCP server gw has no valid url.",
		);
	});

	it("closes the client a use built, waiting for a use under way", async () => {
		const client = fakeClient({});
		const conn = createMcpConnection(config, { client, transport: {} });
		const connecting = conn.connect();
		await conn.close();
		await connecting;
		expect(client.connect).toHaveBeenCalledOnce();
		expect(client.close).toHaveBeenCalledOnce();
	});

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
		expect(tool?.serverId).toBe("gw");
		expect(tool?.annotations).toEqual({ readOnlyHint: false });
		expect(tool?.raw.surface).toEqual({ kind: "draft" });
	});

	it("reads annotations or a resource sent as a list as no object", async () => {
		const client = fakeClient({
			toolsList: { tools: [{ name: "delete_item", annotations: [] }] },
			call: { content: [{ type: "resource", resource: ["a"] }] },
		});
		const conn = createMcpConnection(config, { client, transport: {} });
		await conn.connect();
		const [tool] = await conn.listTools();
		expect(tool?.name).toBe("delete_item");
		expect(tool?.annotations).toBeUndefined();
		// A list once read as annotations with no hint, which waved this
		// delete past the write gate. The line above pins the connection's
		// half; this one replays the original report, end to end.
		expect(
			tool && defaultWriteSignal(tool),
			"a delete_item left with no usable hint is still gated by its name",
		).toBe(true);
		const result = await conn.callTool("delete_item", {});
		expect(result.content).toEqual([{ type: "resource", resource: {} }]);
	});

	it("maps a call result into content and the error flag", async () => {
		const client = fakeClient({
			call: { content: [{ type: "text", text: "done" }], isError: false },
		});
		const conn = createMcpConnection(config, { client, transport: {} });
		await conn.connect();
		const result = await conn.callTool("slack_post", { a: 1 });
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		expect(result).toMatchObject({ isError: false });
	});

	it("surfaces a transport failure as an errored result carrying the status", async () => {
		const client = fakeClient({
			callThrows: { code: 401, message: "unauthorized" },
		});
		const conn = createMcpConnection(config, { client, transport: {} });
		await conn.connect();
		const result = await conn.callTool("slack_post", {});
		expect(result).toMatchObject({ isError: true });
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

// Last in the file: until it unmocks, every connection's first load fails.
describe("a connection whose SDK fails to load", () => {
	it("answers a call with the failure, tries again on the next use and closes without loading", async () => {
		vi.resetModules();
		const loads = { tried: 0 };
		vi.doMock("../../../lib/mcp/sdk-client.ts", () => {
			loads.tried += 1;
			throw new Error("sdk gone");
		});
		try {
			const fresh = await import("../../../lib/mcp/connection.ts");
			const client = fakeClient({});
			const conn = fresh.createMcpConnection(config, { client, transport: {} });
			// Vitest words a failed mock in its own error, so the call is held
			// to the message a connect rejects with, whatever its wording.
			const failure: unknown = await conn.connect().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(Error);
			const result = await conn.callTool("slack_post", {});
			expect(result).toMatchObject({
				isError: true,
				content: [
					{
						type: "text",
						text: failure instanceof Error ? failure.message : "",
					},
				],
			});
			expect(loads.tried, "loads tried by a connect and a call").toBe(2);
			await conn.close();
			expect(loads.tried, "loads tried once closed").toBe(2);
			expect(client.close).not.toHaveBeenCalled();
		} finally {
			vi.doUnmock("../../../lib/mcp/sdk-client.ts");
		}
	});
});
