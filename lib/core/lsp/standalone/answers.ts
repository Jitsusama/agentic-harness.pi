/**
 * A language server's answers in the tool's terms: diagnostics,
 * locations, symbols, hover text and the edits a rename returns.
 *
 * Apart from the server because these change when the protocol's
 * shapes or the tool's do, while the server changes when how it
 * talks to the process does. Nothing here sends or waits; a
 * position's lines come from whoever holds the documents.
 */

import type {
	DocumentSymbol,
	Location,
	LocationLink,
	WorkspaceEdit as ProtocolWorkspaceEdit,
	SymbolInformation,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import type {
	Diagnostic,
	DiagnosticSeverity,
	LspLocation,
	SymbolInfo,
} from "../types.ts";
import {
	fromProtocolRange,
	type LspProtocolTextEdit,
	uriToFile,
} from "./document.ts";

/** A file's current lines, by its path, as the server's caller holds them. */
export type LinesFor = (path: string) => readonly string[];

/** A diagnostic as the protocol carries it, before it is the tool's. */
export interface ProtocolDiagnostic {
	readonly range: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
	readonly severity?: number;
	readonly message: string;
	readonly source?: string;
	readonly code?: string | number;
}

const SEVERITY: Readonly<Record<number, DiagnosticSeverity>> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

/** A protocol diagnostic against a file's lines, in the tool's terms. */
export function toDiagnostic(
	path: string,
	lines: readonly string[],
	d: ProtocolDiagnostic,
): Diagnostic {
	return {
		path,
		range: fromProtocolRange(lines, d.range),
		severity: SEVERITY[d.severity ?? 1] ?? "error",
		message: d.message,
		...(d.source ? { source: d.source } : {}),
		...(d.code !== undefined ? { code: String(d.code) } : {}),
	};
}

/**
 * A protocol workspace edit's plain text edits, by the document they
 * change, whichever of its two forms the server sent.
 */
export function editsByUri(
	edit: ProtocolWorkspaceEdit,
): Map<string, LspProtocolTextEdit[]> {
	const byUri = new Map<string, LspProtocolTextEdit[]>();
	const plainEdits = (
		edits: readonly {
			range: LspProtocolTextEdit["range"];
			newText?: string;
		}[],
	): LspProtocolTextEdit[] =>
		edits.flatMap((e) =>
			typeof e.newText === "string"
				? [{ range: e.range, newText: e.newText }]
				: [],
		);
	if (edit.changes) {
		for (const [uri, edits] of Object.entries(edit.changes)) {
			byUri.set(uri, plainEdits(edits));
		}
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && "edits" in change) {
				byUri.set(change.textDocument.uri, plainEdits(change.edits));
			}
		}
	}
	return byUri;
}

/** A symbol from a document or workspace query, in the tool's terms. */
export function fromSymbolInformation(
	item: SymbolInformation | WorkspaceSymbol,
	linesFor: LinesFor,
): SymbolInfo {
	const location = item.location;
	const path = uriToFile(location.uri);
	// A WorkspaceSymbol may carry only a uri, without a range.
	const range =
		"range" in location
			? fromProtocolRange(linesFor(path), location.range)
			: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 0 },
				};
	return {
		name: item.name,
		kind: symbolKindName(item.kind),
		location: { path, range },
		...(item.containerName ? { containerName: item.containerName } : {}),
	};
}

/** A document symbol and every one nested in it, flat, each naming its container. */
export function flattenDocumentSymbol(
	path: string,
	lines: readonly string[],
	symbol: DocumentSymbol,
	container?: string,
): SymbolInfo[] {
	const self: SymbolInfo = {
		name: symbol.name,
		kind: symbolKindName(symbol.kind),
		location: { path, range: fromProtocolRange(lines, symbol.range) },
		...(container ? { containerName: container } : {}),
	};
	const children = (symbol.children ?? []).flatMap((child) =>
		flattenDocumentSymbol(path, lines, child, symbol.name),
	);
	return [self, ...children];
}

/** A definition or references answer, in any of its shapes, as locations. */
export function toLocations(
	result: Location | Location[] | LocationLink[] | null,
	linesFor: LinesFor,
): LspLocation[] {
	if (!result) return [];
	const array = Array.isArray(result) ? result : [result];
	return array.map((item) => {
		if ("targetUri" in item) {
			const path = uriToFile(item.targetUri);
			return {
				path,
				range: fromProtocolRange(linesFor(path), item.targetRange),
			};
		}
		const path = uriToFile(item.uri);
		return {
			path,
			range: fromProtocolRange(linesFor(path), item.range),
		};
	});
}

/** A hover's contents as text, in any of the shapes the protocol allows. */
export function hoverText(contents: unknown): string {
	if (contents === null || contents === undefined) return "";
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).join("\n");
	if (typeof contents === "object") {
		const value = (contents as { value?: unknown }).value;
		if (typeof value === "string") return value;
	}
	return "";
}

const SYMBOL_KINDS: Readonly<Record<number, string>> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum-member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type-parameter",
};

function symbolKindName(kind: number): string {
	return SYMBOL_KINDS[kind] ?? "symbol";
}
