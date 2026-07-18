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

import { existsSync, readFileSync } from "node:fs";
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
	/**
	 * Resolve the command and args to run for a given project root,
	 * overriding the static command and args. Returns null when no
	 * compatible server exists for that project, so the backend
	 * degrades with a clear message instead of spawning one that
	 * cannot serve. Lets the TypeScript entry pick between the
	 * native LSP and the classic wrapper by the installed version.
	 */
	readonly resolve?: (
		root: string,
		env: NodeJS.ProcessEnv,
	) => { command: string; args: readonly string[] } | null;
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
		// The command and args are the TypeScript 7 default; `resolve`
		// picks the actual server per project by its installed version.
		command: "tsc",
		args: ["--lsp", "--stdio"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
		resolve: resolveTypescriptServer,
	},
};

/**
 * The major version of the TypeScript package installed nearest to
 * `fromDir`, walking up through node_modules, or null when none is
 * found or its version cannot be read.
 */
export function typescriptMajorAt(fromDir: string): number | null {
	let dir = fromDir;
	while (true) {
		const pkg = join(dir, "node_modules", "typescript", "package.json");
		if (existsSync(pkg)) {
			try {
				const { version } = JSON.parse(readFileSync(pkg, "utf8"));
				const major = Number.parseInt(String(version).split(".")[0], 10);
				return Number.isNaN(major) ? null : major;
			} catch {
				// An unreadable or malformed package.json tells us nothing.
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Choose the TypeScript language server for a project by its
 * installed TypeScript version. TypeScript 7 and newer ship a
 * native LSP reached through `tsc --lsp`; older releases need the
 * classic tsserver wrapper, typescript-language-server. Returns
 * null when neither is usable, so an older project without the
 * wrapper degrades with a clear message rather than spawning a
 * tsc that cannot speak LSP.
 */
function resolveTypescriptServer(
	root: string,
	env: NodeJS.ProcessEnv,
): { command: string; args: readonly string[] } | null {
	const native = { command: "tsc", args: ["--lsp", "--stdio"] };
	const classic = { command: "typescript-language-server", args: ["--stdio"] };
	const has = (command: string): boolean =>
		resolveBinary(command, root, env) !== null;
	const major = typescriptMajorAt(root);
	if (major !== null && major < 7) {
		return has(classic.command) ? classic : null;
	}
	// TypeScript 7 or newer, or an unknown version (tsc 7 is the
	// current default): prefer the native server, fall back to the
	// classic wrapper only if tsc is somehow absent.
	if (has(native.command)) return native;
	return has(classic.command) ? classic : null;
}

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
