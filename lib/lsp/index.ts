/**
 * Public surface of the LSP library.
 *
 * Semantic code intelligence behind one backend-agnostic
 * contract. The harness ships a standalone backend that
 * spawns and supervises language servers itself; downstream
 * packages (neovim.pi) register their own backend at a lower
 * priority to take over when an editor is paired. Consumers
 * resolve the active backend with `resolveLspBackend` and
 * call the `LspBackend` operations without knowing which
 * backend answered.
 */

export { DEFAULT_SERVERS, type ServerConfig } from "./config.js";
export {
	clearLspBackends,
	getLspBackend,
	listLspBackends,
	registerLspBackend,
	resolveLspBackend,
	unregisterLspBackend,
} from "./registry.js";
export {
	createStandaloneBackend,
	MissingServerError,
	type StandaloneBackend,
	type StandaloneBackendOptions,
} from "./standalone/backend.js";
export type {
	CodeAction,
	Diagnostic,
	DiagnosticSeverity,
	HoverInfo,
	LspBackend,
	LspBackendEntry,
	LspLocation,
	LspPosition,
	LspRange,
	LspTarget,
	LspTextEdit,
	SymbolInfo,
	WorkspaceEdit,
} from "./types.js";
