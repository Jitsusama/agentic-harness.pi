/**
 * The standalone backend: routing plus a live server pool.
 *
 * Every operation carries a file, so the file is the routing
 * key. The backend resolves the file's candidate servers,
 * walks up to each server's project root, resolves its binary
 * local-bin-first then on PATH, and reuses or spawns one
 * server per (serverName, root). Type-intelligence operations
 * route to the single non-linter server for the root, while
 * diagnostics aggregate across every server attached to the
 * file. When nothing resolves, it fails with a clear message
 * rather than a cryptic one.
 *
 * A server nobody has called for `idleMs` is stopped and dropped
 * from the pool, and the next call for its root starts a fresh
 * one: a TypeScript server holds hundreds of megabytes, and a long
 * session touches many roots it never returns to. A call in
 * flight keeps its servers alive however long it takes.
 *
 * The live server pool lives in this closure's memory for the
 * life of the process that constructs it. A stateless-per-call
 * CLI adapter that wants warm servers across invocations needs
 * its own keep-alive design on top of this (the same shape as
 * quest's on-disk state file, or core/browser's file-backed
 * session registry) -- not something this module does itself.
 */

import { bounded } from "../../../clock/bound.ts";
import {
	DEFAULT_SERVERS,
	resolveBinary,
	resolveRoot,
	type ServerConfig,
	serversForFile,
} from "../config.ts";
import type {
	CodeAction,
	Diagnostic,
	HoverInfo,
	LspBackend,
	LspCallOptions,
	LspLocation,
	LspRange,
	LspTarget,
	SymbolInfo,
	WorkspaceEdit,
} from "../types.ts";
import { StandaloneServer } from "./server.ts";

/** Raised when no server can serve a file, with why per candidate. */
export class MissingServerError extends Error {
	constructor(filePath: string, reasons: readonly string[]) {
		super(
			`No language server available for ${filePath}. ${reasons.join("; ")}. ` +
				"Provision a server as a project dev-dependency, in a devshell, or on PATH.",
		);
		this.name = "MissingServerError";
	}
}

/** Options for constructing a standalone backend. */
export interface StandaloneBackendOptions {
	/** Server map to route against. Defaults to the built-in map. */
	readonly servers?: Readonly<Record<string, ServerConfig>>;
	/** Environment used for PATH resolution. Defaults to process.env. */
	readonly env?: NodeJS.ProcessEnv;
	/** How long a server may sit unused before it is stopped. */
	readonly idleMs?: number;
	/** How long one call may wait on its servers before it is given up on. */
	readonly requestMs?: number;
}

/**
 * Default idle window. Long enough that a burst of work on one
 * project keeps its server warm, short enough that a project left
 * behind gives its memory back within the hour.
 */
const DEFAULT_IDLE_MS = 10 * 60_000;

/**
 * Default request clock. References across a large project on a cold
 * server have taken tens of seconds; two minutes is well past that and
 * still ends a request a server has simply stopped answering.
 */
const DEFAULT_REQUEST_MS = 2 * 60_000;

/** A standalone backend with visibility into its live pool. */
export interface StandaloneBackend extends LspBackend {
	/** Number of live servers currently pooled. */
	serverCount(): number;
	/** Re-sync a document after the caller edited it. */
	syncDocument(path: string, text: string): void;
}

/** Construct a standalone backend over the given (or default) server map. */
export function createStandaloneBackend(
	options: StandaloneBackendOptions = {},
): StandaloneBackend {
	const servers = options.servers ?? DEFAULT_SERVERS;
	const env = options.env ?? process.env;
	const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
	const requestMs = options.requestMs ?? DEFAULT_REQUEST_MS;
	const pool = new Map<string, Promise<StandaloneServer>>();
	// Calls in flight per pool key, and the stop timer armed when a
	// key's last call finishes.
	const inFlight = new Map<string, number>();
	const idleTimers = new Map<string, NodeJS.Timeout>();

	const poolKey = (name: string, root: string): string => `${name}|${root}`;

	const claim = (key: string): void => {
		inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
		clearTimeout(idleTimers.get(key));
		idleTimers.delete(key);
	};

	const release = (key: string): void => {
		const left = (inFlight.get(key) ?? 1) - 1;
		if (left > 0) {
			inFlight.set(key, left);
			return;
		}
		inFlight.delete(key);
		const timer = setTimeout(() => stopIdle(key), idleMs);
		// An idle server must never be what keeps the process alive.
		timer.unref();
		idleTimers.set(key, timer);
	};

	const stopIdle = (key: string): void => {
		idleTimers.delete(key);
		if (inFlight.has(key)) return;
		const started = pool.get(key);
		pool.delete(key);
		void started?.then(
			(server) => server.dispose(),
			() => {},
		);
	};

	const instanceFor = (
		server: ServerConfig,
		root: string,
		binary: string,
	): { key: string; started: Promise<StandaloneServer> } => {
		const key = poolKey(server.name, root);
		const existing = pool.get(key);
		if (existing) return { key, started: existing };
		const started = StandaloneServer.start(server, root, binary);
		pool.set(key, started);
		// A server that died stays dead, and its connection answers every
		// later call with "Connection is closed." Drop it from the pool, so
		// the next call for this root starts one afresh. Only this entry:
		// a replacement may already be in its place.
		const evict = () => {
			if (pool.get(key) === started) pool.delete(key);
		};
		// A start that failed goes too, rather than failing every later
		// call the same way; the caller awaiting it still sees why.
		started.then((live) => live.onGone(evict), evict);
		return { key, started };
	};

	// Resolve a server's effective command and args for a root. A
	// server with a `resolve` hook picks its binary per project (the
	// TypeScript entry chooses the native LSP or the classic wrapper
	// by version); a null result means nothing compatible is present.
	const effectiveServer = (
		server: ServerConfig,
		root: string,
	): { config: ServerConfig; binary: string } | { reason: string } => {
		const resolved = server.resolve
			? server.resolve(root, env)
			: { command: server.command, args: server.args };
		if (!resolved) {
			return {
				reason: `${server.name}: no compatible server for this project's TypeScript version`,
			};
		}
		const binary = resolveBinary(resolved.command, root, env);
		if (!binary) {
			return { reason: `${server.name}: binary ${resolved.command} not found` };
		}
		return {
			config: { ...server, command: resolved.command, args: resolved.args },
			binary,
		};
	};

	/**
	 * Run fn against the servers for a file, holding each one's pool
	 * key claimed from before it resolves until fn settles, so no
	 * server is stopped under a call that is using it.
	 */
	const withInstances = async <T>(
		filePath: string,
		typeOnly: boolean,
		fn: (instances: StandaloneServer[]) => Promise<T>,
	): Promise<T> => {
		const claimed: string[] = [];
		try {
			return await fn(await resolveInstances(filePath, typeOnly, claimed));
		} finally {
			for (const key of claimed) release(key);
		}
	};

	const resolveInstances = async (
		filePath: string,
		typeOnly: boolean,
		claimed: string[],
	): Promise<StandaloneServer[]> => {
		const candidates = serversForFile(filePath, servers).filter(
			(server) => !typeOnly || !server.isLinter,
		);
		const instances: StandaloneServer[] = [];
		const reasons: string[] = [];
		for (const server of candidates) {
			const root = resolveRoot(filePath, server.rootMarkers);
			if (!root) {
				reasons.push(`${server.name}: no project root marker found`);
				continue;
			}
			const eff = effectiveServer(server, root);
			if ("reason" in eff) {
				reasons.push(eff.reason);
				continue;
			}
			const { key, started } = instanceFor(eff.config, root, eff.binary);
			claim(key);
			claimed.push(key);
			instances.push(await started);
			if (typeOnly) break;
		}
		if (instances.length === 0) {
			if (candidates.length === 0) {
				reasons.push("no server handles this file type");
			}
			throw new MissingServerError(filePath, reasons);
		}
		return instances;
	};

	/**
	 * Workspace symbols carry no file, so they search every server
	 * already running; nothing is spawned on demand, and a server
	 * stopped for idleness is not searched until something file-bound
	 * starts it again.
	 */
	const searchWorkspace = async (
		query: string,
		signal: AbortSignal,
	): Promise<SymbolInfo[]> => {
		const keys = [...pool.keys()];
		for (const key of keys) claim(key);
		try {
			const live = await Promise.all(keys.map((key) => pool.get(key)));
			const results = await Promise.all(
				live.map((server) => server?.workspaceSymbols(query, signal) ?? []),
			);
			return results.flat();
		} finally {
			for (const key of keys) release(key);
		}
	};

	/**
	 * Run one call under the caller's signal and the request clock.
	 *
	 * The work gets a signal of its own, which fires when the caller
	 * gives up or the clock runs out, and the server is told to stop
	 * through it. The wait ends either way: a server that ignores the
	 * cancellation keeps its own time, not the caller's.
	 */
	const call = <T>(
		what: string,
		options: LspCallOptions | undefined,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		const stop = new AbortController();
		return bounded(
			work(stop.signal),
			{
				...(options?.signal ? { signal: options.signal } : {}),
				wallMs: requestMs,
				what,
			},
			() => stop.abort(),
		);
	};

	return {
		name: "standalone",

		async diagnostics(
			path: string,
			options?: LspCallOptions,
		): Promise<Diagnostic[]> {
			return call(`diagnostics for ${path}`, options, (signal) =>
				withInstances(path, false, async (instances) => {
					const results = await Promise.all(
						instances.map((s) => s.diagnose(path, signal)),
					);
					return results.flat();
				}),
			);
		},

		async definition(
			target: LspTarget,
			options?: LspCallOptions,
		): Promise<LspLocation[]> {
			return call(`definition in ${target.path}`, options, (signal) =>
				withInstances(target.path, true, ([server]) =>
					server.definition(target, signal),
				),
			);
		},

		async references(
			target: LspTarget,
			options?: LspCallOptions,
		): Promise<LspLocation[]> {
			return call(`references in ${target.path}`, options, (signal) =>
				withInstances(target.path, true, ([server]) =>
					server.references(target, signal),
				),
			);
		},

		async hover(
			target: LspTarget,
			options?: LspCallOptions,
		): Promise<HoverInfo | null> {
			return call(`hover in ${target.path}`, options, (signal) =>
				withInstances(target.path, true, ([server]) =>
					server.hover(target, signal),
				),
			);
		},

		async documentSymbols(
			path: string,
			options?: LspCallOptions,
		): Promise<SymbolInfo[]> {
			return call(`symbols in ${path}`, options, (signal) =>
				withInstances(path, true, ([server]) =>
					server.documentSymbols(path, signal),
				),
			);
		},

		async workspaceSymbols(
			query: string,
			options?: LspCallOptions,
		): Promise<SymbolInfo[]> {
			return call(`workspace symbols for ${query}`, options, (signal) =>
				searchWorkspace(query, signal),
			);
		},

		async rename(
			target: LspTarget,
			newName: string,
			options?: LspCallOptions,
		): Promise<WorkspaceEdit> {
			return call(`rename in ${target.path}`, options, (signal) =>
				withInstances(target.path, true, ([server]) =>
					server.rename(target, newName, signal),
				),
			);
		},

		async codeActions(
			path: string,
			range?: LspRange,
			options?: LspCallOptions,
		): Promise<CodeAction[]> {
			return call(`code actions in ${path}`, options, (signal) =>
				withInstances(path, true, ([server]) =>
					server.codeActions(path, range, signal),
				),
			);
		},

		syncDocument(path: string, text: string): void {
			for (const started of pool.values()) {
				void started.then((server) => {
					if (path.startsWith(server.root)) server.syncDocument(path, text);
				});
			}
		},

		serverCount(): number {
			return pool.size;
		},

		async dispose(): Promise<void> {
			for (const timer of idleTimers.values()) clearTimeout(timer);
			idleTimers.clear();
			const started = [...pool.values()];
			pool.clear();
			await Promise.all(
				started.map((s) => s.then((server) => server.dispose())),
			);
		},
	};
}
