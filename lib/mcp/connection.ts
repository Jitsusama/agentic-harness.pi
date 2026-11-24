import { loadOnce } from "../internal/process/single-flight.ts";
import { isRecord } from "../internal/record.ts";
import {
	type McpContent,
	McpError,
	type McpServerConfig,
	type McpTool,
	type McpToolResult,
} from "./types.ts";

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

// The SDK and zod hold about 12 MB of heap once imported, and a session
// whose cached tool list stands in may never connect, so they load on a
// connection's first use rather than with this module.
const sdkModule = loadOnce(() => import("./sdk-client.ts"));

/** A connection's SDK, with the client and transport it opened with. */
interface Opened {
	sdk: Awaited<ReturnType<typeof sdkModule>>;
	client: SdkClientLike;
	transport: unknown;
}

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
	const subscribers = new Set<() => void>();
	let used = false;
	let built: Omit<Opened, "sdk"> | undefined;
	// The client is built once, after the SDK's first load. `loadOnce`
	// forgets a failed load, so the next use tries again.
	const open = async (): Promise<Opened> => {
		used = true;
		const sdk = await sdkModule();
		if (built === undefined && deps.client) {
			built = { client: deps.client, transport: deps.transport };
		} else if (built === undefined) {
			const made = sdk.buildSdkClient(config);
			built = {
				client: made.client as unknown as SdkClientLike,
				transport: deps.transport ?? made.transport,
			};
		}
		return { sdk, ...built };
	};

	return {
		async connect() {
			const { sdk, client, transport } = await open();
			client.setNotificationHandler(
				sdk.ToolListChangedNotificationSchema,
				() => {
					for (const handler of subscribers) handler();
				},
			);
			await client.connect(transport);
		},
		async close() {
			// A connection never used has no client to close.
			if (!used) return;
			await (await open()).client.close();
		},
		async listTools() {
			const { sdk, client } = await open();
			const { LooseToolsResult } = sdk;
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
				const { sdk, client } = await open();
				const { LooseCallResult } = sdk;
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

function toTool(serverId: string, raw: Record<string, unknown>): McpTool {
	const inputSchema = raw.inputSchema;
	return {
		serverId,
		name: String(raw.name),
		description: typeof raw.description === "string" ? raw.description : "",
		inputSchema:
			isRecord(inputSchema) && inputSchema.type === "object"
				? (inputSchema as unknown as McpTool["inputSchema"])
				: { type: "object" },
		annotations: isRecord(raw.annotations)
			? (raw.annotations as McpTool["annotations"])
			: undefined,
		raw,
	};
}

function mapContent(blocks: unknown[]): McpContent[] {
	const out: McpContent[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) continue;
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
					resource: isRecord(block.resource) ? block.resource : {},
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
