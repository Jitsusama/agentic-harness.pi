/**
 * Plain-text rendering for LSP operation results. Shared by every
 * adapter's tool/CLI output -- pure string formatting, no I/O.
 */

import type {
	CodeAction,
	Diagnostic,
	HoverInfo,
	LspLocation,
	SymbolInfo,
	WorkspaceEdit,
} from "./types.ts";

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
	if (diagnostics.length === 0) return "No problems reported.";
	return diagnostics
		.map((d) => {
			const where = `${d.path}:${d.range.start.line}:${d.range.start.character}`;
			const tail = [d.source, d.code].filter(Boolean).join(" ");
			return `${d.severity} ${where} ${d.message}${tail ? ` (${tail})` : ""}`;
		})
		.join("\n");
}

export function formatLocations(locations: readonly LspLocation[]): string {
	if (locations.length === 0) return "No results.";
	return locations
		.map((l) => `${l.path}:${l.range.start.line}:${l.range.start.character}`)
		.join("\n");
}

export function formatSymbols(symbols: readonly SymbolInfo[]): string {
	if (symbols.length === 0) return "No symbols.";
	return symbols
		.map((s) => {
			const where = `${s.location.path}:${s.location.range.start.line}`;
			const container = s.containerName ? ` in ${s.containerName}` : "";
			return `${s.kind} ${s.name}${container} (${where})`;
		})
		.join("\n");
}

export function formatHover(hover: HoverInfo): string {
	return hover.contents.trim() || "No hover information.";
}

export function formatCodeActions(actions: readonly CodeAction[]): string {
	if (actions.length === 0) return "No code actions.";
	return actions
		.map((a) => (a.kind ? `${a.title} [${a.kind}]` : a.title))
		.join("\n");
}

export function formatWorkspaceEdit(edit: WorkspaceEdit): string {
	if (edit.changes.length === 0) return "Rename made no changes.";
	const files = edit.changes.length;
	const edits = edit.changes.reduce((n, c) => n + c.edits.length, 0);
	const lines = edit.changes.map((c) => `- ${c.path}: ${c.edits.length} edits`);
	return [
		`Renamed and wrote ${edits} edits across ${files} files:`,
		...lines,
	].join("\n");
}
