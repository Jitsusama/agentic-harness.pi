/**
 * The MCP SDK's side of a connection: the client, its transport and the
 * schemas its requests parse with.
 *
 * Importing the SDK and zod costs about 12 MB of heap, and a session whose
 * cached tool list stands in may never connect, so `connection.ts` loads
 * this module only when a connection is first used.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpServerConfig } from "./types.ts";

/** The notification a server sends when its tool list changes. */
export { ToolListChangedNotificationSchema };

// Passthrough schemas: the SDK strips unknown per-tool keys under its own zod
// schema, so we parse loosely to keep non-standard fields (for example a
// `surface` block) reaching `raw`.
const LooseTool = z.looseObject({ name: z.string() });

/** A tools/list result, keeping each tool's fields the SDK doesn't know. */
export const LooseToolsResult = z.looseObject({
	tools: z.array(LooseTool).default([]),
});

/** A tools/call result, keeping the fields the SDK doesn't know. */
export const LooseCallResult = z.looseObject({
	content: z.array(z.unknown()).default([]),
	isError: z.boolean().optional(),
});

/** The SDK's client and its streamable HTTP transport for `config`. */
export function buildSdkClient(config: McpServerConfig): {
	client: Client;
	transport: StreamableHTTPClientTransport;
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
	return { client, transport };
}
