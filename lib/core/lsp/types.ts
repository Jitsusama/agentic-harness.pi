/**
 * Backend-agnostic surface for semantic code intelligence.
 *
 * One tool speaks these shapes; a standalone backend that spawns
 * language servers itself and an editor-forwarding backend both
 * normalize to them, so a caller cannot tell which answered.
 *
 * Positions follow the convention pi's own LSP integration
 * established: a 1-indexed line and a 0-indexed UTF-8 byte
 * column. The LSP protocol itself is 0-indexed and counts UTF-16
 * code units, so a backend translates at its edge.
 */

/** A point in a file: 1-indexed line, 0-indexed UTF-8 byte column. */
export interface LspPosition {
	readonly line: number;
	readonly character: number;
}

/** A half-open span between two positions. */
export interface LspRange {
	readonly start: LspPosition;
	readonly end: LspPosition;
}

/** A range within a specific file. */
export interface LspLocation {
	readonly path: string;
	readonly range: LspRange;
}

/** Diagnostic severity, normalized to words rather than LSP's integers. */
export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

/** One problem the server reported against a file. */
export interface Diagnostic {
	readonly path: string;
	readonly range: LspRange;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	readonly source?: string;
	readonly code?: string;
}

/** A file path plus the position an operation targets. */
export interface LspTarget {
	readonly path: string;
	readonly position: LspPosition;
}

/** A single text replacement within a file. */
export interface LspTextEdit {
	readonly range: LspRange;
	readonly newText: string;
}

/** Edits grouped by the file they touch. */
export interface WorkspaceEdit {
	readonly changes: ReadonlyArray<{
		readonly path: string;
		readonly edits: readonly LspTextEdit[];
	}>;
}

/** A symbol the server knows about, with where it lives. */
export interface SymbolInfo {
	readonly name: string;
	readonly kind: string;
	readonly location: LspLocation;
	readonly containerName?: string;
}

/** Hover documentation for a position, as plain text or markdown. */
export interface HoverInfo {
	readonly contents: string;
	readonly range?: LspRange;
}

/** A code action the server offers at a position or range. */
export interface CodeAction {
	readonly title: string;
	readonly kind?: string;
}

/**
 * What a caller can say about one call. A backend that cannot stop
 * its work early may ignore the signal, so a caller that must not
 * wait past it bounds the call itself as well.
 */
export interface LspCallOptions {
	/** The caller giving up. The call ends, and the server is told. */
	readonly signal?: AbortSignal;
}

/**
 * A registered backend and the rule for when it may serve.
 * Lower priority resolves first, so a downstream backend can
 * register below the standalone default to take over when its
 * own precondition is met.
 */
export interface LspBackendEntry {
	/** Stable backend name. */
	readonly name: string;
	/** Lower numbers resolve first; the standalone default sits at 100. */
	readonly priority: number;
	/** Whether this backend can serve right now. */
	isAvailable(): boolean;
	/** The backend itself. */
	readonly backend: LspBackend;
}

/**
 * The operations a backend serves. The foundation ships
 * diagnostics, definition and references; write operations
 * (rename, hover, symbols, code actions) widen this contract
 * as they land.
 */
export interface LspBackend {
	/** Stable name used in backend selection and messages. */
	readonly name: string;
	/** Problems the server reports against a file's current bytes. */
	diagnostics(
		path: string,
		options?: LspCallOptions,
	): Promise<readonly Diagnostic[]>;
	/** Where the symbol under the target is defined. */
	definition(
		target: LspTarget,
		options?: LspCallOptions,
	): Promise<readonly LspLocation[]>;
	/** Every reference to the symbol under the target. */
	references(
		target: LspTarget,
		options?: LspCallOptions,
	): Promise<readonly LspLocation[]>;
	/** Documentation for the symbol under the target, or null. */
	hover(target: LspTarget, options?: LspCallOptions): Promise<HoverInfo | null>;
	/** Symbols declared in one file. */
	documentSymbols(
		path: string,
		options?: LspCallOptions,
	): Promise<readonly SymbolInfo[]>;
	/** Symbols across the project matching a query. */
	workspaceSymbols(
		query: string,
		options?: LspCallOptions,
	): Promise<readonly SymbolInfo[]>;
	/**
	 * Rename the symbol under the target across its root and
	 * apply the edits, returning what changed.
	 */
	rename(
		target: LspTarget,
		newName: string,
		options?: LspCallOptions,
	): Promise<WorkspaceEdit>;
	/** Code actions the server offers for a file, optionally at a range. */
	codeActions(
		path: string,
		range?: LspRange,
		options?: LspCallOptions,
	): Promise<readonly CodeAction[]>;
	/** Release every server the backend holds open. */
	dispose(): Promise<void>;
}
