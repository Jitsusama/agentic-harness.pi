/**
 * Public surface of the generic MCP integration library.
 *
 * A server-agnostic core for connecting to an MCP server over streamable
 * HTTP, mapping its tools onto pi's tool surface, and rendering calls and
 * results. Server-specific behaviour is supplied by downstream layers through
 * the policy and front-end seams; nothing here names a particular server.
 *
 * This barrel grows as the core is built. For now it exports the shared value
 * types (see `types.ts`).
 */

export type {
	McpContent,
	McpServerConfig,
	McpTool,
	McpToolAnnotations,
	McpToolInputSchema,
	McpToolResult,
} from "./types.js";
export { McpError } from "./types.js";
