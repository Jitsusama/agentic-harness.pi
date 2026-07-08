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
	createStandaloneBackend,
	type Diagnostic,
	type LspLocation,
	MissingServerError,
	registerLspBackend,
	resolveLspBackend,
	type StandaloneBackend,
	unregisterLspBackend,
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
			"operation=diagnostics reports the problems in a file; " +
			"operation=definition finds where the symbol at a position is " +
			"defined; operation=references finds every use of it. Positions " +
			"are a 1-indexed line and a 0-indexed byte column, the same " +
			"coordinates read and grep report. Prefer this over grep for " +
			"exact definitions and references.",
		promptSnippet:
			"Use the lsp tool for exact definitions, references and diagnostics " +
			"instead of guessing from a text search.",
		parameters: Type.Object({
			operation: Type.Union(
				[
					Type.Literal("diagnostics"),
					Type.Literal("definition"),
					Type.Literal("references"),
				],
				{ description: "Which intelligence operation to run." },
			),
			path: Type.String({ description: "File path the operation targets." }),
			line: Type.Optional(
				Type.Number({
					description:
						"1-indexed line. Required for definition and references.",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description:
						"0-indexed byte column. Required for definition and references.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<LspToolDetails>> {
			const active = resolveLspBackend() ?? ensureBackend();
			const path = isAbsolute(params.path)
				? params.path
				: resolve(process.cwd(), params.path);
			try {
				if (params.operation === "diagnostics") {
					const diagnostics = await active.diagnostics(path);
					return {
						content: [{ type: "text", text: formatDiagnostics(diagnostics) }],
						details: {
							ok: true,
							operation: "diagnostics",
							count: diagnostics.length,
						},
					};
				}
				if (params.line === undefined || params.character === undefined) {
					return {
						content: [
							{
								type: "text",
								text: `${params.operation} needs a line and character position.`,
							},
						],
						details: { ok: false, operation: params.operation },
					};
				}
				const target = {
					path,
					position: { line: params.line, character: params.character },
				};
				const locations =
					params.operation === "definition"
						? await active.definition(target)
						: await active.references(target);
				return {
					content: [{ type: "text", text: formatLocations(locations) }],
					details: {
						ok: true,
						operation: params.operation,
						count: locations.length,
					},
				};
			} catch (err) {
				if (err instanceof MissingServerError) {
					return {
						content: [{ type: "text", text: err.message }],
						details: { ok: false, operation: params.operation },
					};
				}
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
