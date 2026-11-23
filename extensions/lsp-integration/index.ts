/**
 * LSP Integration extension.
 *
 * Bridges pi to language servers through the `lsp` tool. The
 * domain logic lives in agentic-harness.core's lsp module; this
 * extension is the thin wiring: it registers the standalone
 * backend, exposes the tool, keeps the servers in step with
 * pi's own edits, and releases the shared servers after the last
 * runner shuts down.
 *
 * The tool resolves whichever backend is active, so when
 * neovim.pi registers a higher-priority backend for a paired
 * session, the same tool routes to it with no change to how
 * it is called. No slash command: the agent calls the tool
 * when a task needs semantic understanding of the code.
 *
 * Every call takes the tool's signal and a clock of its own, so a
 * server that stops answering ends the call rather than holding it,
 * and a person who stops it stops the server's work as well.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { bounded, WallClockExceeded } from "../../lib/clock/index.ts";
import { standaloneLease } from "../../lib/core/internal/lsp/standalone.ts";
import {
	clearLspBackends,
	formatCodeActions,
	formatDiagnostics,
	formatHover,
	formatLocations,
	formatSymbols,
	formatWorkspaceEdit,
	LEFT_OUT,
	MissingServerError,
	readJudged,
	registerLspBackend,
	resolveLspBackend,
	toBackendEntry,
	unregisterLspBackend,
} from "../../lib/core/lsp/index.ts";
import { citeListing } from "../../lib/core/result/listing.ts";
import { openSessionStore } from "../../lib/core/result/location.ts";
import {
	ambientSession,
	hosted,
	type SessionRef,
	sessionEnv,
	sessionKeyOf,
} from "../../lib/core/session/index.ts";
import {
	type Sandbox,
	sandboxFor,
} from "../../lib/internal/sandbox/sandbox.ts";
import { offeredShellEnvironment } from "../../lib/internal/shell/environment.ts";
import {
	readSshGuard,
	type SshGuard,
} from "../../lib/internal/shell/ssh-guard.ts";
import { type FencedSession, fenceKey, lspFence } from "./fence.ts";
import { LSP_CALL_WALL_MS } from "./limits.ts";
import { fencedPool, fences, UNFENCED_POOL } from "./pool.ts";

/**
 * What vscode-jsonrpc says when its server has gone:
 * "Connection is closed." once the process exits, "Connection is
 * disposed." once something tore it down, and the rejection a request
 * still waiting gets when the connection is disposed under it.
 */
const GONE =
	/^(?:Connection is (?:closed|disposed)\.?|Pending response rejected since connection got disposed)$/;

/** Whether `err` says the server behind the connection has gone. */
export function closedConnection(err: unknown): boolean {
	return err instanceof Error && GONE.test(err.message);
}

/**
 * The session a fence is drawn for, as its shell draws its commands':
 * from the conversation's environment, with what is offered to its
 * commands and its id, around its own folder, the ssh guard read as a
 * server starts. pi names the session only on its own spawns, so it is
 * named here, as pi's file tools' fence names it.
 */
function fencedSession(ctx: ExtensionContext): FencedSession {
	const conversation = sessionKeyOf(ctx);
	return {
		session: conversation,
		cwd: ctx.cwd,
		env: {
			...sessionEnv(conversation).snapshot(),
			...offeredShellEnvironment(),
			PI_SESSION_ID: conversation,
		},
		guard: guardNow,
	};
}

/** The ssh guard as last read here, once one has been. */
let lastGuard: SshGuard | undefined;

/**
 * The ssh guard as it stands, kept as the shell's watch keeps it: a
 * node that is slow to answer leaves the machines last read, and a
 * setting that can't be read leaves the guard as last read. Never read
 * at all, it fails the start, rather than letting the server's code
 * reach machines the commands can't.
 */
async function guardNow(): Promise<SshGuard> {
	let read: SshGuard;
	try {
		read = await readSshGuard(lastGuard);
	} catch (error) {
		if (lastGuard) return lastGuard;
		throw new Error(
			`the ssh guard's setting can't be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	lastGuard = read;
	return read;
}

/** File types the standalone backend can currently serve. */
const SYNCABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

interface LspToolDetails {
	readonly ok: boolean;
	readonly operation?: string;
	readonly count?: number;
}

const POSITION_OPS = new Set(["definition", "references", "hover", "rename"]);

export default function lspIntegration(pi: ExtensionAPI) {
	let session: SessionRef | undefined = ambientSession();
	// Drawn at the first call, as the shell drew its own once it loaded
	// (shell-workflow lifts the fence from process.env first), so a
	// session's servers run in the sandbox its commands run in.
	let sandbox: Sandbox | undefined;
	// The conversation as last seen, which the lease registers the pool
	// for before anything can look it up.
	let conversation: ExtensionContext | undefined;
	// The pool as the conversation's other extensions reach it: with its
	// fence drawn into each call, drawn afresh at each lookup.
	const lease = standaloneLease((pool) => {
		sandbox ??= sandboxFor();
		if (sandbox.kind === "none") return pool;
		const seen = conversation;
		if (!seen)
			throw new Error("pi's language servers were looked up before a session");
		return fencedPool(
			pool,
			lspFence(sandbox, () => fencedSession(seen)),
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		session = sessionKeyOf(ctx);
		conversation = ctx;
		lease.ensure(ctx);
	});

	// A paired editor (neovim.pi) cannot import this registry across
	// isolated package roots, so it registers its backend over the
	// shared event bus. We validate the payload (it comes from a
	// third-party emitter) and add it; a higher-priority editor backend
	// then wins resolution while it reports itself available.
	pi.events.on("lsp:register-backend", (data: unknown) => {
		const entry = toBackendEntry(data);
		if (entry) registerLspBackend(entry, session);
	});
	pi.events.on("lsp:unregister-backend", (data: unknown) => {
		if (typeof data === "object" && data !== null) {
			const name = (data as Record<string, unknown>).name;
			if (typeof name === "string") unregisterLspBackend(name, session);
		}
	});
	// Signal that the registry is listening, so a provider that loaded
	// before us can re-register on receipt.
	pi.events.emit("lsp:ready", {});

	// Keep the servers current with pi's own edits so diagnostics
	// track the bytes on disk rather than the bytes at open. A fenced
	// server can write where the file was, so it is read without
	// waiting and only as a plain file: a pipe left there can't hold
	// pi's thread (`judged-files.ts`).
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = event.input.path;
		if (typeof path !== "string" || !SYNCABLE.test(path)) return;
		const absolute = isAbsolute(path) ? path : resolve(ctx.cwd, path);
		try {
			lease.current()?.syncDocument(absolute, readJudged(absolute, undefined));
		} catch {
			// The file may have been deleted or moved; a stale sync
			// is not worth disturbing the edit over.
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// Its servers could answer no other conversation, and run its
		// project's code in its fence until stopped.
		const current = lease.current();
		if (sandbox && sandbox.kind !== "none" && current && fences(current))
			current.stopFence(fenceKey(sandbox, sessionKeyOf(ctx)));
		await lease.release(ctx);
		if (hosted() && event.reason === "quit") clearLspBackends(ctx);
	});

	pi.registerTool({
		name: "lsp",
		// Called in 11 of 77 sessions from 8 October: loaded on demand.
		exposure: "deferred",
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
			signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<LspToolDetails>> {
			conversation = ctx;
			let active = resolveLspBackend(ctx) ?? lease.ensure(ctx);
			let standalone = active === lease.current();
			const op = params.operation;
			// A `records` argument rather than a details heuristic: these
			// details carry a count, not the findings, and the count is
			// what the renderers read. References across a large project
			// are the answer worth bounding here, and passing the array
			// says plainly which one is being stored.
			const text = (
				body: string,
				count?: number,
				records?: readonly unknown[],
				// Said after the listing, which a cut for its size never drops.
				trailer?: string,
			): AgentToolResult<LspToolDetails> => ({
				content: [
					{
						type: "text",
						text:
							records === undefined || records.length === 0
								? trailer
									? `${body}\n${trailer}`
									: body
								: citeListing(openSessionStore(ctx), {
										view: body,
										records,
										...(trailer ? { trailer } : {}),
										unit: `${op} results`,
										narrowing:
											"Ask about one file or one symbol rather than the " +
											"whole project.",
									}),
					},
				],
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
				isAbsolute(p) ? p : resolve(ctx.cwd, p);
			// The backend gets a signal that fires on either the caller
			// stopping or the clock running out, so a backend that can tell
			// its server to cancel does so on both.
			const stop = new AbortController();
			sandbox ??= sandboxFor();
			const fence = lspFence(sandbox, () => fencedSession(ctx));
			// An editor's servers run outside the fence, as the editor started
			// them, so a fenced call asks pi's own, which start inside it.
			if (fence && !standalone) {
				active = lease.ensure(ctx);
				standalone = true;
			}
			if (fence && !fences(active)) return bad(UNFENCED_POOL);
			const options = {
				signal: stop.signal,
				root: ctx.cwd,
				...(fence ? { fence } : {}),
			};
			const ask = <T>(work: Promise<T>): Promise<T> =>
				bounded(
					work,
					{
						...(signal ? { signal } : {}),
						wallMs: LSP_CALL_WALL_MS,
						what: `The language server's ${op} answer`,
					},
					() => stop.abort(),
				);

			// Files pi can't read for a fenced server are left out of these.
			const leftOut = fence ? LEFT_OUT : undefined;
			const answer = async (): Promise<AgentToolResult<LspToolDetails>> => {
				if (op === "workspace_symbols") {
					if (!params.query) return bad("workspace_symbols needs a query.");
					const found = await ask(
						active.workspaceSymbols(params.query, options),
					);
					const symbols = found.filter((symbol) => {
						const path = relative(ctx.cwd, symbol.location.path);
						return (
							path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
						);
					});
					return text(formatSymbols(symbols), symbols.length, symbols, leftOut);
				}
				if (!params.path) return bad(`${op} needs a path.`);
				const path = absolute(params.path);

				if (op === "diagnostics") {
					const diagnostics = await ask(active.diagnostics(path, options));
					return text(
						formatDiagnostics(diagnostics),
						diagnostics.length,
						diagnostics,
					);
				}
				if (op === "document_symbols") {
					const symbols = await ask(active.documentSymbols(path, options));
					return text(formatSymbols(symbols), symbols.length, symbols);
				}
				if (op === "code_actions") {
					const actions = await ask(
						active.codeActions(path, undefined, options),
					);
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
					const hover = await ask(active.hover(target, options));
					return text(hover ? formatHover(hover) : "No hover information.");
				}
				if (op === "rename") {
					if (!params.newName) return bad("rename needs a newName.");
					const edit = await ask(
						active.rename(target, params.newName, options),
					);
					return text(formatWorkspaceEdit(edit), edit.changes.length);
				}
				const locations =
					op === "definition"
						? await ask(active.definition(target, options))
						: await ask(active.references(target, options));
				return text(
					formatLocations(locations),
					locations.length,
					locations,
					leftOut,
				);
			};

			try {
				try {
					return await answer();
				} catch (err) {
					// A server that died leaves its connection closed, and the
					// pool hands the same dead one to every later call: 11 of 93
					// calls failed that way. Start the standalone servers afresh
					// and ask once more. A fenced call's server may have been ended
					// by its own project's code, so only its fence's servers go, and
					// every other conversation's keep theirs. An editor's backend is
					// the editor's to restart, so its failure is reported as it came.
					if (!closedConnection(err) || !standalone) throw err;
					if (fence && fences(active)) active.dropFence(fence.key);
					else active = await lease.restart(active, ctx);
					return await answer();
				}
			} catch (err) {
				if (err instanceof MissingServerError) return bad(err.message);
				// A server that ran out the clock is an answer the agent can act
				// on: ask something narrower, or fall back to reading the code.
				// A stop is not, so it still throws, which is how pi marks a
				// call that was stopped.
				if (err instanceof WallClockExceeded) return bad(err.message);
				throw err;
			}
		},
	});
}
