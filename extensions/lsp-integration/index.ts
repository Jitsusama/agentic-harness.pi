/**
 * LSP Integration extension.
 *
 * Bridges pi to language servers through the `lsp` tool. The
 * domain logic lives in lib/lsp; this extension is the thin
 * wiring: it registers the standalone backend, exposes the
 * tool, keeps the servers in step with pi's own edits, and
 * disposes everything at shutdown.
 *
 * The tool resolves whichever backend is active, so when
 * neovim.pi registers a higher-priority backend for a paired
 * session, the same tool routes to it with no change to how
 * it is called. No slash command: the agent calls the tool
 * when a task needs semantic understanding of the code.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	type CodeAction,
	createStandaloneBackend,
	type Diagnostic,
	type HoverInfo,
	type LspLocation,
	MissingServerError,
	registerLspBackend,
	resolveLspBackend,
	type StandaloneBackend,
	type SymbolInfo,
	unregisterLspBackend,
	type WorkspaceEdit,
} from "../../lib/lsp/index.js";

const STANDALONE = "standalone";
/** The standalone backend registers here; a paired editor sits below it. */
const STANDALONE_PRIORITY = 100;

/** File types the standalone backend can currently serve. */
const SYNCABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

interface LspToolDetails {
	readonly ok: boolean;
	readonly operation?: string;
	readonly count?: number;
}

const POSITION_OPS = new Set(["definition", "references", "hover", "rename"]);

export default function lspIntegration(pi: ExtensionAPI) {
	let backend: StandaloneBackend | null = null;

	const ensureBackend = (): StandaloneBackend => {
		if (!backend) {
			backend = createStandaloneBackend();
			registerLspBackend({
				name: STANDALONE,
				priority: STANDALONE_PRIORITY,
				isAvailable: () => true,
				backend,
			});
		}
		return backend;
	};

	pi.on("session_start", async () => {
		ensureBackend();
	});

	// Keep the servers current with pi's own edits so diagnostics
	// track the bytes on disk rather than the bytes at open.
	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = event.input.path;
		if (typeof path !== "string" || !SYNCABLE.test(path)) return;
		const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
		try {
			backend?.syncDocument(absolute, readFileSync(absolute, "utf8"));
		} catch {
			// The file may have been deleted or moved; a stale sync
			// is not worth disturbing the edit over.
		}
	});

	pi.on("session_shutdown", async () => {
		unregisterLspBackend(STANDALONE);
		const closing = backend;
		backend = null;
		await closing?.dispose();
	});

	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description:
			"Semantic code intelligence from a real language server. " +
			"Operations: diagnostics (problems in a file), definition and " +
			"references (where a symbol is defined and used), hover (its " +
			"type and docs), document_symbols (what a file declares), " +
			"workspace_symbols (search symbols by query), rename (rename a " +
			"symbol project-wide and write the edits), and code_actions. " +
			"Positions are a 1-indexed line and a 0-indexed byte column, the " +
			"same coordinates read and grep report. Prefer this over grep for " +
			"exact definitions, references and safe renames.",
		promptSnippet:
			"Use the lsp tool for exact definitions, references and diagnostics " +
			"instead of guessing from a text search.",
		parameters: Type.Object({
			operation: Type.Union(
				[
					Type.Literal("diagnostics"),
					Type.Literal("definition"),
					Type.Literal("references"),
					Type.Literal("hover"),
					Type.Literal("document_symbols"),
					Type.Literal("workspace_symbols"),
					Type.Literal("rename"),
					Type.Literal("code_actions"),
				],
				{ description: "Which intelligence operation to run." },
			),
			path: Type.Optional(
				Type.String({
					description:
						"File path the operation targets. Not needed for workspace_symbols.",
				}),
			),
			line: Type.Optional(
				Type.Number({
					description:
						"1-indexed line. Required for definition, references, hover and rename.",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description:
						"0-indexed byte column. Required for definition, references, hover and rename.",
				}),
			),
			newName: Type.Optional(
				Type.String({ description: "New name. Required for rename." }),
			),
			query: Type.Optional(
				Type.String({
					description: "Search text. Required for workspace_symbols.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<LspToolDetails>> {
			const active = resolveLspBackend() ?? ensureBackend();
			const op = params.operation;
			const text = (
				body: string,
				count?: number,
			): AgentToolResult<LspToolDetails> => ({
				content: [{ type: "text", text: body }],
				details: {
					ok: true,
					operation: op,
					...(count === undefined ? {} : { count }),
				},
			});
			const bad = (body: string): AgentToolResult<LspToolDetails> => ({
				content: [{ type: "text", text: body }],
				details: { ok: false, operation: op },
			});
			const absolute = (p: string): string =>
				isAbsolute(p) ? p : resolve(process.cwd(), p);

			try {
				if (op === "workspace_symbols") {
					if (!params.query) return bad("workspace_symbols needs a query.");
					const symbols = await active.workspaceSymbols(params.query);
					return text(formatSymbols(symbols), symbols.length);
				}
				if (!params.path) return bad(`${op} needs a path.`);
				const path = absolute(params.path);

				if (op === "diagnostics") {
					const diagnostics = await active.diagnostics(path);
					return text(formatDiagnostics(diagnostics), diagnostics.length);
				}
				if (op === "document_symbols") {
					const symbols = await active.documentSymbols(path);
					return text(formatSymbols(symbols), symbols.length);
				}
				if (op === "code_actions") {
					const actions = await active.codeActions(path);
					return text(formatCodeActions(actions), actions.length);
				}

				// The remaining operations are position-based.
				if (
					POSITION_OPS.has(op) &&
					(params.line === undefined || params.character === undefined)
				) {
					return bad(`${op} needs a line and character position.`);
				}
				const target = {
					path,
					position: {
						line: params.line ?? 1,
						character: params.character ?? 0,
					},
				};
				if (op === "hover") {
					const hover = await active.hover(target);
					return text(hover ? formatHover(hover) : "No hover information.");
				}
				if (op === "rename") {
					if (!params.newName) return bad("rename needs a newName.");
					const edit = await active.rename(target, params.newName);
					return text(formatWorkspaceEdit(edit), edit.changes.length);
				}
				const locations =
					op === "definition"
						? await active.definition(target)
						: await active.references(target);
				return text(formatLocations(locations), locations.length);
			} catch (err) {
				if (err instanceof MissingServerError) return bad(err.message);
				throw err;
			}
		},
	});
}

function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
	if (diagnostics.length === 0) return "No problems reported.";
	return diagnostics
		.map((d) => {
			const where = `${d.path}:${d.range.start.line}:${d.range.start.character}`;
			const tail = [d.source, d.code].filter(Boolean).join(" ");
			return `${d.severity} ${where} ${d.message}${tail ? ` (${tail})` : ""}`;
		})
		.join("\n");
}

function formatLocations(locations: readonly LspLocation[]): string {
	if (locations.length === 0) return "No results.";
	return locations
		.map((l) => `${l.path}:${l.range.start.line}:${l.range.start.character}`)
		.join("\n");
}

function formatSymbols(symbols: readonly SymbolInfo[]): string {
	if (symbols.length === 0) return "No symbols.";
	return symbols
		.map((s) => {
			const where = `${s.location.path}:${s.location.range.start.line}`;
			const container = s.containerName ? ` in ${s.containerName}` : "";
			return `${s.kind} ${s.name}${container} (${where})`;
		})
		.join("\n");
}

function formatHover(hover: HoverInfo): string {
	return hover.contents.trim() || "No hover information.";
}

function formatCodeActions(actions: readonly CodeAction[]): string {
	if (actions.length === 0) return "No code actions.";
	return actions
		.map((a) => (a.kind ? `${a.title} [${a.kind}]` : a.title))
		.join("\n");
}

function formatWorkspaceEdit(edit: WorkspaceEdit): string {
	if (edit.changes.length === 0) return "Rename made no changes.";
	const files = edit.changes.length;
	const edits = edit.changes.reduce((n, c) => n + c.edits.length, 0);
	const lines = edit.changes.map((c) => `- ${c.path}: ${c.edits.length} edits`);
	return [
		`Renamed and wrote ${edits} edits across ${files} files:`,
		...lines,
	].join("\n");
}
