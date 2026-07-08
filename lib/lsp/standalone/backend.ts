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
 */

import {
	DEFAULT_SERVERS,
	resolveBinary,
	resolveRoot,
	type ServerConfig,
	serversForFile,
} from "../config.js";
import type {
	Diagnostic,
	LspBackend,
	LspLocation,
	LspTarget,
} from "../types.js";
import { StandaloneServer } from "./server.js";

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
}

/** A standalone backend with visibility into its live pool. */
export interface StandaloneBackend extends LspBackend {
	/** Number of live servers currently pooled. */
	serverCount(): number;
	/** Re-sync a document after pi edited it. */
	syncDocument(path: string, text: string): void;
}

/** Construct a standalone backend over the given (or default) server map. */
export function createStandaloneBackend(
	options: StandaloneBackendOptions = {},
): StandaloneBackend {
	const servers = options.servers ?? DEFAULT_SERVERS;
	const env = options.env ?? process.env;
	const pool = new Map<string, Promise<StandaloneServer>>();

	const poolKey = (name: string, root: string): string =>
		`${name}\u0000${root}`;

	const instanceFor = (
		server: ServerConfig,
		root: string,
	): Promise<StandaloneServer> => {
		const key = poolKey(server.name, root);
		const existing = pool.get(key);
		if (existing) return existing;
		const binary = resolveBinary(server.command, root, env);
		if (!binary) throw new Error(`binary ${server.command} not found`);
		const started = StandaloneServer.start(server, root, binary);
		pool.set(key, started);
		return started;
	};

	const resolveInstances = async (
		filePath: string,
		typeOnly: boolean,
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
			if (!resolveBinary(server.command, root, env)) {
				reasons.push(`${server.name}: binary ${server.command} not found`);
				continue;
			}
			instances.push(await instanceFor(server, root));
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

	return {
		name: "standalone",

		async diagnostics(path: string): Promise<Diagnostic[]> {
			const instances = await resolveInstances(path, false);
			const results = await Promise.all(instances.map((s) => s.diagnose(path)));
			return results.flat();
		},

		async definition(target: LspTarget): Promise<LspLocation[]> {
			const [server] = await resolveInstances(target.path, true);
			return server.definition(target);
		},

		async references(target: LspTarget): Promise<LspLocation[]> {
			const [server] = await resolveInstances(target.path, true);
			return server.references(target);
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
			const started = [...pool.values()];
			pool.clear();
			await Promise.all(
				started.map((s) => s.then((server) => server.dispose())),
			);
		},
	};
}
