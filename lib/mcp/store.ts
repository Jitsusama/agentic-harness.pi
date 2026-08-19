/**
 * The result store, as MCP names it.
 *
 * The store itself is general and lives in agentic-harness.core's result module: an MCP
 * server's oversized payload and a browser tool's page outline
 * want exactly the same thing, so they use exactly the same store.
 * This module exists so the MCP surface and its consumers keep
 * importing the name they always did.
 */

export {
	createResultStore,
	HandleExpiredError,
	type ResultStore,
	type StoredResult,
} from "@jitsusama/agentic-harness.core/result";
