/**
 * Document helpers for the standalone backend: file URIs,
 * language ids, and the position mapping between the tool's
 * 1-indexed line plus 0-indexed byte column and LSP's
 * 0-indexed line plus 0-indexed UTF-16 column.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { byteToUtf16, utf16ToByte } from "../offsets.js";
import type { LspPosition, LspRange } from "../types.js";

/** A position in LSP's own coordinates: 0-indexed line, 0-indexed UTF-16 column. */
export interface LspProtocolPosition {
	readonly line: number;
	readonly character: number;
}

/** A range in LSP's own coordinates. */
export interface LspProtocolRange {
	readonly start: LspProtocolPosition;
	readonly end: LspProtocolPosition;
}

/** Absolute file path to a `file://` URI. */
export function fileToUri(filePath: string): string {
	return pathToFileURL(filePath).toString();
}

/** `file://` URI back to an absolute file path. */
export function uriToFile(uri: string): string {
	return fileURLToPath(uri);
}

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
};

/** The LSP languageId for a file, defaulting to plaintext. */
export function languageIdFor(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	const ext = dot < 0 ? "" : filePath.slice(dot);
	return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

/** Split file text into lines, dropping line terminators. */
export function toLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/** Map a tool position to LSP protocol coordinates using the file's lines. */
export function toProtocolPosition(
	lines: readonly string[],
	pos: LspPosition,
): LspProtocolPosition {
	const line = pos.line - 1;
	const lineText = lines[line] ?? "";
	return { line, character: byteToUtf16(lineText, pos.character) };
}

/** Map an LSP protocol position back to a tool position using the file's lines. */
export function fromProtocolPosition(
	lines: readonly string[],
	pos: LspProtocolPosition,
): LspPosition {
	const lineText = lines[pos.line] ?? "";
	return {
		line: pos.line + 1,
		character: utf16ToByte(lineText, pos.character),
	};
}

/** Map an LSP protocol range back to a tool range using the file's lines. */
export function fromProtocolRange(
	lines: readonly string[],
	range: LspProtocolRange,
): LspRange {
	return {
		start: fromProtocolPosition(lines, range.start),
		end: fromProtocolPosition(lines, range.end),
	};
}

/** A protocol text edit: a UTF-16 range and its replacement. */
export interface LspProtocolTextEdit {
	readonly range: LspProtocolRange;
	readonly newText: string;
}

/**
 * Apply LSP protocol edits to a document's text. Protocol
 * positions are UTF-16 offsets, which match a JavaScript
 * string's own indexing, so an edit's absolute offset is the
 * line's start offset plus its character. Edits apply from
 * the end backwards so earlier splices never shift later
 * offsets.
 */
export function applyProtocolEdits(
	text: string,
	edits: readonly LspProtocolTextEdit[],
): string {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") lineStarts.push(i + 1);
	}
	const offsetOf = (pos: LspProtocolPosition): number =>
		(lineStarts[pos.line] ?? text.length) + pos.character;
	const ordered = [...edits].sort(
		(a, b) => offsetOf(b.range.start) - offsetOf(a.range.start),
	);
	let result = text;
	for (const edit of ordered) {
		const start = offsetOf(edit.range.start);
		const end = offsetOf(edit.range.end);
		result = result.slice(0, start) + edit.newText + result.slice(end);
	}
	return result;
}
