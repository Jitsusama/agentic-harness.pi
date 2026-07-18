/**
 * Public surface of the generic MCP integration library.
 *
 * A server-agnostic core for connecting to an MCP server over streamable
 * HTTP, mapping its tools onto pi's tool surface, and rendering calls and
 * results. Server-specific behaviour is supplied by downstream layers through
 * the policy and front-end seams; nothing here names a particular server.
 *
 * Hosts assemble a connection, a front-end registry and a surface manager, then
 * apply the reconcile deltas to pi. Providers contribute a FrontEndProvider,
 * directly or over the event bus. Both draw the render and content utilities
 * from here.
 */

// ── Ceiling ─────────────────────────────────────────────────
export {
	type CeilingOptions,
	contentByteSize,
	DEFAULT_RESULT_CEILING_BYTES,
	enforceResultCeiling,
	type SpillTarget,
} from "./ceiling.js";
// ── Config panel ────────────────────────────────────────────
export {
	changedValues,
	runSurfaceConfigPanel,
	type SurfaceConfigPanelInput,
	type SurfaceConfigPanelResult,
} from "./config-panel.js";
// ── Connection ──────────────────────────────────────────────
export {
	createMcpConnection,
	type McpConnection,
	mcpErrorFrom,
	type SdkClientLike,
} from "./connection.js";
// ── Content utilities ───────────────────────────────────────
export {
	type FailedResource,
	imageContent,
	joinTextContent,
	materializeResources,
	type SavedResource,
	spillToFile,
	truncateForDisplay,
} from "./content.js";
export {
	defaultResolved,
	defaultWriteSignal,
	identityShape,
	makeDefaultWrap,
	makeTruncatingShape,
	toAgentContent,
	WRITE_VERBS,
} from "./frontend/defaults.js";
export {
	hostFrontEndBus,
	isFrontEndProvider,
	MCP_READY,
	MCP_REGISTER_FRONTEND,
	MCP_UNREGISTER_FRONTEND,
	provideFrontEnd,
} from "./frontend/events.js";
export {
	createFrontEndRegistry,
	type FrontEndRegistry,
} from "./frontend/registry.js";
// ── Front-end seam ──────────────────────────────────────────
export type {
	ConfirmResult,
	FrontEndMatcher,
	FrontEndProvider,
	FrontEndRenderContext,
	Invoke,
	ResolvedFrontEnd,
	WrappedExecute,
} from "./frontend/types.js";
// ── JSON summary ─────────────────────────────────────
export {
	type JsonSummaryContentOptions,
	type JsonSummaryOptions,
	jsonSummaryContent,
	summarizeJson,
} from "./json-summary.js";
// ── Query ───────────────────────────────────────────────
export { type QueryOptions, queryStoredJson } from "./query.js";
// ── Rendering ───────────────────────────────────────────────
export { renderDefaultCall } from "./render/call.js";
export { CANCELLED_TEXT, renderDefaultResult } from "./render/result.js";
export {
	buildDiscoverySections,
	type DiscoveryEntry,
	modeBadge,
	renderToolDiscovery,
} from "./render/tools-list.js";
// ── Result store ─────────────────────────────────────
export {
	createResultStore,
	HandleExpiredError,
	type ResultStore,
	type StoredResult,
} from "./store.js";
// ── Progressive helpers ─────────────────────────────────────
export {
	createProgressiveHelpers,
	type HelperDescriptor,
} from "./surface/helpers.js";
// ── Surface manager ─────────────────────────────────────────
export {
	createSurfaceManager,
	type SurfaceDelta,
	type SurfaceManager,
	type ToolRegistrationDescriptor,
} from "./surface/manager.js";
// ── Surface policy ──────────────────────────────────────────
export {
	defaultBackendOf,
	resolveToolMode,
	type ServerPolicy,
	type SurfaceConfig,
	type ToolMode,
} from "./surface/policy.js";
export type {
	McpContent,
	McpServerConfig,
	McpTool,
	McpToolAnnotations,
	McpToolInputSchema,
	McpToolResult,
} from "./types.js";
// ── Value types ─────────────────────────────────────────────
export { McpError } from "./types.js";
