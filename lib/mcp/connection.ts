import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	type McpContent,
	McpError,
	type McpServerConfig,
	type McpTool,
	type McpToolResult,
} from "./types.js";

/** The slice of the SDK client the connection depends on, so a fake can stand in for tests. */
export interface SdkClientLike {
	connect(transport: unknown): Promise<void>;
	close(): Promise<void>;
	request(
		request: { method: string; params?: unknown },
		schema: unknown,
		options?: unknown,
	): Promise<unknown>;
	setNotificationHandler(schema: unknown, handler: () => void): void;
}

/** An instance-scoped connection to one MCP server. */
export interface McpConnection {
	connect(): Promise<void>;
	close(): Promise<void>;
	listTools(): Promise<McpTool[]>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<McpToolResult>;
	onToolsListChanged(handler: () => void): () => void;
}

// Passthrough schemas: the SDK strips unknown per-tool keys under its own zod
// schema, so we parse loosely to keep non-standard fields (for example a
// `surface` block) reaching `raw`.
const LooseTool = z.object({ name: z.string() }).passthrough();
const LooseToolsResult = z
	.object({ tools: z.array(LooseTool).default([]) })
	.passthrough();
const LooseCallResult = z
	.object({
		content: z.array(z.unknown()).default([]),
		isError: z.boolean().optional(),
	})
	.passthrough();

const HTTP_STATUS_FLOOR = 100;
const HTTP_STATUS_CEIL = 600;

/**
 * Normalise any thrown value into an McpError. A transport error carries an
 * HTTP status in `code` (for example 401), while a JSON-RPC error carries a
 * negative code (for example -32001); they are separated so callers can tell
 * an auth failure from a protocol error.
 */
export function mcpErrorFrom(err: unknown): McpError {
	if (err instanceof McpError) return err;
	const source = (err ?? {}) as { code?: unknown; message?: unknown };
	const code = typeof source.code === "number" ? source.code : undefined;
	const message =
		typeof source.message === "string" ? source.message : String(err);
	const isHttp =
		code !== undefined && code >= HTTP_STATUS_FLOOR && code < HTTP_STATUS_CEIL;
	return new McpError(message, {
		status: isHttp ? code : undefined,
		code: isHttp ? undefined : code,
		cause: err,
	});
}

/** Create a connection to `config`. Injected `client`/`transport` are for tests; production builds the SDK client. */
export function createMcpConnection(
	config: McpServerConfig,
	deps: { client?: SdkClientLike; transport?: unknown } = {},
): McpConnection {
	const built = deps.client ? undefined : buildSdkClient(config);
	const client = deps.client ?? (built as { client: SdkClientLike }).client;
	const transport =
		deps.transport ?? (built as { transport: unknown }).transport;
	const subscribers = new Set<() => void>();

	return {
		async connect() {
			client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
				for (const handler of subscribers) handler();
			});
			await client.connect(transport);
		},
		async close() {
			await client.close();
		},
		async listTools() {
			const parsed = LooseToolsResult.parse(
				await client.request(
					{ method: "tools/list", params: {} },
					LooseToolsResult,
				),
			);
			return parsed.tools.map((raw) => toTool(config.id, raw));
		},
		async callTool(name, args, opts) {
			try {
				const raw = await client.request(
					{ method: "tools/call", params: { name, arguments: args } },
					LooseCallResult,
					{
						signal: opts?.signal,
						timeout: opts?.timeoutMs,
					},
				);
				const parsed = LooseCallResult.parse(raw) as {
					content: unknown[];
					isError?: boolean;
					structuredContent?: unknown;
					_meta?: unknown;
				};
				return {
					content: mapContent(parsed.content),
					isError: parsed.isError === true,
					structuredContent: parsed.structuredContent,
					_meta: parsed._meta,
				};
			} catch (err) {
				const error = mcpErrorFrom(err);
				return {
					content: [
						{ type: "text", text: error.message || "Tool call failed." },
					],
					isError: true,
					_meta: { transportError: { status: error.status, code: error.code } },
				};
			}
		},
		onToolsListChanged(handler) {
			subscribers.add(handler);
			return () => subscribers.delete(handler);
		},
	};
}

function buildSdkClient(config: McpServerConfig): {
	client: SdkClientLike;
	transport: unknown;
} {
	const headers: Record<string, string> = { ...config.headers };
	if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
	const transport = new StreamableHTTPClientTransport(new URL(config.url), {
		requestInit: { headers },
	});
	const client = new Client(
		{ name: `mcp-${config.id}`, version: "0.1.0" },
		{ capabilities: {} },
	);
	return { client: client as unknown as SdkClientLike, transport };
}

function toTool(serverId: string, raw: Record<string, unknown>): McpTool {
	const inputSchema = raw.inputSchema;
	return {
		serverId,
		name: String(raw.name),
		description: typeof raw.description === "string" ? raw.description : "",
		inputSchema:
			isObject(inputSchema) && inputSchema.type === "object"
				? (inputSchema as unknown as McpTool["inputSchema"])
				: { type: "object" },
		annotations: isObject(raw.annotations)
			? (raw.annotations as McpTool["annotations"])
			: undefined,
		raw,
	};
}

function mapContent(blocks: unknown[]): McpContent[] {
	const out: McpContent[] = [];
	for (const block of blocks) {
		if (!isObject(block)) continue;
		switch (block.type) {
			case "text":
				out.push({ type: "text", text: String(block.text ?? "") });
				break;
			case "image":
				out.push({
					type: "image",
					data: String(block.data ?? ""),
					mimeType: mime(block),
				});
				break;
			case "audio":
				out.push({
					type: "audio",
					data: String(block.data ?? ""),
					mimeType: mime(block),
				});
				break;
			case "resource":
				out.push({
					type: "resource",
					resource: isObject(block.resource) ? block.resource : {},
				});
				break;
			case "resource_link":
				out.push({
					type: "resource_link",
					uri: String(block.uri ?? ""),
					name: typeof block.name === "string" ? block.name : undefined,
					description:
						typeof block.description === "string"
							? block.description
							: undefined,
					mimeType:
						typeof block.mimeType === "string" ? block.mimeType : undefined,
				});
				break;
		}
	}
	return out;
}

function mime(block: Record<string, unknown>): string {
	return String(block.mimeType ?? block.mime_type ?? "");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
