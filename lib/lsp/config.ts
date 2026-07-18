/**
 * Server discovery: a built-in default map, a config-override
 * chain, and the resolution that routes a file to the server
 * and project root that should serve it.
 *
 * The model follows omp's proven design: declare servers by
 * the file types they handle and the root markers that mark a
 * project, detect binaries rather than install them, and bind
 * one server per resolved root. We ship the servers we use and
 * grow the map, rather than omp's full catalogue.
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** One server's declaration: how to run it and what it serves. */
export interface ServerConfig {
	/** Stable server name, the pool key's first half. */
	readonly name: string;
	/** Executable to spawn, resolved local-bin-first then on PATH. */
	readonly command: string;
	/** Arguments passed to the executable. */
	readonly args: readonly string[];
	/** File extensions (with the dot) this server handles. */
	readonly fileTypes: readonly string[];
	/** Files or dirs whose presence marks a project root. */
	readonly rootMarkers: readonly string[];
	/** LSP initialize options, passed through untouched. */
	readonly initOptions?: Record<string, unknown>;
	/** A disabled server is never spawned. */
	readonly disabled?: boolean;
	/** Linters and formatters contribute diagnostics only. */
	readonly isLinter?: boolean;
}

/**
 * The built-in server map. TypeScript first; Go and Ruby and
 * the rest arrive as the harness reaches for them.
 */
export const DEFAULT_SERVERS: Readonly<Record<string, ServerConfig>> = {
	typescript: {
		name: "typescript",
		// TypeScript 7's native compiler ships its own language server
		// over stdio, replacing the retired tsserver-based wrapper.
		command: "tsc",
		args: ["--lsp", "--stdio"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
	},
};

/** A server matched to a file, with the root it should run at. */
export interface ResolvedServer {
	readonly server: ServerConfig;
	readonly root: string;
}

/**
 * Candidate servers for a file: every non-disabled server
 * whose fileTypes include the file's extension. A file can
 * match a type server plus one or more linters.
 */
export function serversForFile(
	filePath: string,
	servers: Readonly<Record<string, ServerConfig>> = DEFAULT_SERVERS,
): ServerConfig[] {
	const ext = extname(filePath);
	return Object.values(servers).filter(
		(server) => !server.disabled && server.fileTypes.includes(ext),
	);
}

/**
 * The nearest ancestor directory of `filePath` that contains
 * one of `rootMarkers`, or null when none is found up to the
 * filesystem root.
 */
export function resolveRoot(
	filePath: string,
	rootMarkers: readonly string[],
): string | null {
	let dir = dirname(filePath);
	while (true) {
		for (const marker of rootMarkers) {
			if (existsSync(join(dir, marker))) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Resolve a command to an executable path, preferring a
 * project-local bin (`node_modules/.bin`, `.venv/bin` walked
 * up from `fromDir`) over `$PATH`. Returns null when nothing
 * resolves, so the caller can degrade to a clear message.
 */
export function resolveBinary(
	command: string,
	fromDir: string,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	// An explicit path (absolute or containing a separator) is
	// honoured as-is, so a config override can point straight at
	// a nix store path or a custom binary.
	if (command.includes("/")) return existsSync(command) ? command : null;
	const local = resolveLocalBin(command, fromDir);
	if (local) return local;
	return resolveOnPath(command, env);
}

const LOCAL_BIN_DIRS = ["node_modules/.bin", ".venv/bin"];

function resolveLocalBin(command: string, fromDir: string): string | null {
	let dir = fromDir;
	while (true) {
		for (const binDir of LOCAL_BIN_DIRS) {
			const candidate = join(dir, binDir, command);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
	const path = env.PATH ?? "";
	for (const entry of path.split(delimiter)) {
		if (!entry) continue;
		const candidate = join(entry, command);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function extname(filePath: string): string {
	const base = filePath.slice(filePath.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot);
}
