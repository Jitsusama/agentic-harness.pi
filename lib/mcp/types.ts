/**
 * Core value types shared across the MCP integration.
 *
 * These describe an MCP server, the tools it advertises and the results it
 * returns, independent of any particular server. Nothing here names a
 * specific server or vendor: downstream layers supply server-specific
 * behaviour through the policy and front-end seams, never by extending these
 * shapes.
 */

/**
 * How to reach and identify one MCP server.
 *
 * `id` namespaces everything derived from the server: the front-end registry,
 * the progressive helper tools and the on-disk config are all keyed by it.
 */
export interface McpServerConfig {
	/** Stable server identifier; namespaces front-ends, helpers and config. */
	id: string;
	/** The streamable-HTTP endpoint to connect to. */
	url: string;
	/** Extra request headers. Protected header names are rejected upstream. */
	headers?: Record<string, string>;
	/** Bearer token sent as the `Authorization` header. */
	authToken?: string;
	/** Prepended to emitted pi tool names. Defaults to the empty string. */
	toolNamePrefix?: string;
	/** Prefix for the progressive helper tool names. Defaults to `id`. */
	helperNamespace?: string;
	/** Groups a tool under a backend for the front-end backend tier. Defaults to the first underscore-delimited token. */
	backendOf?: (toolName: string) => string;
}

/**
 * The standard MCP tool behaviour hints, as advertised by a server. Present
 * only where the server chooses to set them.
 */
export interface McpToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** The JSON Schema a tool declares for its arguments. */
export interface McpToolInputSchema {
	type: "object";
	properties?: Record<string, unknown>;
	required?: string[];
}

/**
 * One tool advertised by a server.
 *
 * `raw` keeps the full untouched upstream tool object so a `ServerPolicy` can
 * read non-standard fields (for example a `raw.surface` block) without the
 * core needing to know they exist.
 */
export interface McpTool {
	/** The server this tool belongs to; scopes front-end resolution. */
	serverId: string;
	/** The upstream tool name, before any prefix. */
	name: string;
	description: string;
	inputSchema: McpToolInputSchema;
	/** Standard MCP annotations, present where the server sets them. */
	annotations?: McpToolAnnotations;
	/** The full upstream tool object, including any non-standard fields. */
	raw: Record<string, unknown>;
}

/**
 * A single content block in a tool result.
 *
 * Covers the block kinds a server may return. Unrecognised or richer payloads
 * are preserved on the surrounding result rather than dropped.
 */
export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string }
	| { type: "resource"; resource: Record<string, unknown> }
	| {
			type: "resource_link";
			uri: string;
			name?: string;
			description?: string;
			mimeType?: string;
	  };

/**
 * The result of calling a tool. `structuredContent` and `_meta` are carried
 * through untouched so server-specific hints (for example self-correcting
 * error guidance) survive the content path.
 */
export interface McpToolResult {
	content: McpContent[];
	isError?: boolean;
	structuredContent?: unknown;
	_meta?: unknown;
}

/**
 * An error raised while talking to a server.
 *
 * Wraps the underlying SDK or transport error and carries the HTTP status and
 * the JSON-RPC error code where the source provides them, so callers can tell
 * an auth failure from a method-not-found from a generic server error.
 */
export class McpError extends Error {
	/** HTTP status from the transport, when the failure carried one. */
	readonly status?: number;
	/** JSON-RPC error code, when the failure carried one. */
	readonly code?: number;

	constructor(
		message: string,
		init?: { status?: number; code?: number; cause?: unknown },
	) {
		super(
			message,
			init?.cause !== undefined ? { cause: init.cause } : undefined,
		);
		this.name = "McpError";
		this.status = init?.status;
		this.code = init?.code;
	}
}
