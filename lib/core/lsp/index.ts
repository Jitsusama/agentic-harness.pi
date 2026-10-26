/**
 * Public surface of the LSP library.
 *
 * Semantic code intelligence behind one backend-agnostic
 * contract. This package ships a standalone backend that spawns
 * and supervises language servers itself; a downstream package
 * (an editor integration, say) registers its own backend at a
 * lower priority to take over when paired. Consumers resolve the
 * active backend with `resolveLspBackend` and call the
 * `LspBackend` operations without knowing which backend answered.
 */

export { DEFAULT_SERVERS, type ServerConfig } from "./config.ts";
export { toBackendEntry } from "./external.ts";
export {
	formatCodeActions,
	formatDiagnostics,
	formatHover,
	formatLocations,
	formatSymbols,
	formatWorkspaceEdit,
} from "./format.ts";
export {
	clearLspBackends,
	getLspBackend,
	listLspBackends,
	registerLspBackend,
	resolveLspBackend,
	unregisterLspBackend,
} from "./registry.ts";
export {
	createStandaloneBackend,
	MissingServerError,
	type StandaloneBackend,
	type StandaloneBackendOptions,
} from "./standalone/backend.ts";
export type {
	CodeAction,
	Diagnostic,
	DiagnosticSeverity,
	HoverInfo,
	LspBackend,
	LspBackendEntry,
	LspCallOptions,
	LspLocation,
	LspPosition,
	LspRange,
	LspTarget,
	LspTextEdit,
	SymbolInfo,
	WorkspaceEdit,
} from "./types.ts";
