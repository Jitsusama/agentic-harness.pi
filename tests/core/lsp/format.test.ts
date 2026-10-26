import { describe, expect, it } from "vitest";
import {
	formatCodeActions,
	formatDiagnostics,
	formatHover,
	formatLocations,
	formatSymbols,
	formatWorkspaceEdit,
} from "../../../lib/core/lsp/format.ts";
import type {
	CodeAction,
	Diagnostic,
	LspLocation,
	SymbolInfo,
	WorkspaceEdit,
} from "../../../lib/core/lsp/types.ts";

const range = {
	start: { line: 1, character: 0 },
	end: { line: 1, character: 5 },
};

describe("formatDiagnostics", () => {
	it("reports no problems when empty", () => {
		expect(formatDiagnostics([])).toBe("No problems reported.");
	});

	it("renders severity, location and source/code tail", () => {
		const diagnostics: Diagnostic[] = [
			{
				path: "a.ts",
				range,
				severity: "error",
				message: "Type mismatch",
				source: "ts",
				code: "2322",
			},
		];
		expect(formatDiagnostics(diagnostics)).toBe(
			"error a.ts:1:0 Type mismatch (ts 2322)",
		);
	});
});

describe("formatLocations", () => {
	it("reports no results when empty", () => {
		expect(formatLocations([])).toBe("No results.");
	});

	it("renders path and start position", () => {
		const locations: LspLocation[] = [{ path: "a.ts", range }];
		expect(formatLocations(locations)).toBe("a.ts:1:0");
	});
});

describe("formatSymbols", () => {
	it("reports no symbols when empty", () => {
		expect(formatSymbols([])).toBe("No symbols.");
	});

	it("renders kind, name, container and location", () => {
		const symbols: SymbolInfo[] = [
			{
				name: "greeting",
				kind: "function",
				location: { path: "a.ts", range },
				containerName: "Greeter",
			},
		];
		expect(formatSymbols(symbols)).toBe(
			"function greeting in Greeter (a.ts:1)",
		);
	});
});

describe("formatHover", () => {
	it("trims contents", () => {
		expect(formatHover({ contents: "  hello  " })).toBe("hello");
	});

	it("falls back when contents are blank", () => {
		expect(formatHover({ contents: "   " })).toBe("No hover information.");
	});
});

describe("formatCodeActions", () => {
	it("reports no actions when empty", () => {
		expect(formatCodeActions([])).toBe("No code actions.");
	});

	it("renders title with an optional kind", () => {
		const actions: CodeAction[] = [
			{ title: "Add import" },
			{ title: "Extract to function", kind: "refactor.extract" },
		];
		expect(formatCodeActions(actions)).toBe(
			"Add import\nExtract to function [refactor.extract]",
		);
	});
});

describe("formatWorkspaceEdit", () => {
	it("reports no changes when empty", () => {
		expect(formatWorkspaceEdit({ changes: [] })).toBe(
			"Rename made no changes.",
		);
	});

	it("summarizes files and edits", () => {
		const edit: WorkspaceEdit = {
			changes: [
				{ path: "a.ts", edits: [{ range, newText: "x" }] },
				{
					path: "b.ts",
					edits: [
						{ range, newText: "x" },
						{ range, newText: "y" },
					],
				},
			],
		};
		expect(formatWorkspaceEdit(edit)).toBe(
			"Renamed and wrote 3 edits across 2 files:\n- a.ts: 1 edits\n- b.ts: 2 edits",
		);
	});
});
