/**
 * Resolve the parent pi install so a subagent can be
 * spawned from the exact same binary and entry script the
 * parent is running, rather than from whatever bare `pi`
 * resolves to on PATH.
 *
 * A running pi is typically reached through a profile
 * symlink (a nix profile, a brew shim) that a package
 * upgrade can repoint mid-session. Spawning a child as
 * bare `pi` then lands on the new install while the parent
 * keeps running the old one, and the parent-derived
 * extension and skill paths the child inherits no longer
 * exist. Pinning the child to the parent's dereferenced
 * node binary and entry script removes the skew entirely.
 */

import { realpathSync } from "node:fs";

/** A pinned pi install: the node binary and its entry script. */
export interface PiInstall {
	/** Absolute, dereferenced path to the node binary. */
	readonly node: string;
	/** Absolute, dereferenced path to the pi entry script. */
	readonly entry: string;
}

/** Dependencies for {@link resolveParentPiInstall}. */
export interface ResolvePiInstallDeps {
	/** The parent's node binary, normally `process.execPath`. */
	readonly execPath: string;
	/** The parent's argv, normally `process.argv`. */
	readonly argv: readonly string[];
	/** Symlink dereferencing, normally `fs.realpathSync`. */
	readonly realpath: (p: string) => string;
}

/**
 * Capture the parent's running pi install as dereferenced
 * absolute paths. The node binary comes from `execPath`
 * and the entry script from `argv[1]`, each passed through
 * `realpath` so a later profile repoint cannot move them.
 *
 * Dereferencing is best-effort: if a target cannot be
 * resolved (it was already deleted), the raw path is kept
 * so the caller still has something to spawn and the
 * health check can report it as gone.
 */
export function resolveParentPiInstall(
	deps: Partial<ResolvePiInstallDeps> = {},
): PiInstall {
	const execPath = deps.execPath ?? process.execPath;
	const argv = deps.argv ?? process.argv;
	const realpath = deps.realpath ?? realpathSync;
	const entryPath = argv[1] ?? "";
	return {
		node: dereference(execPath, realpath),
		entry: dereference(entryPath, realpath),
	};
}

function dereference(path: string, realpath: (p: string) => string): string {
	if (!path) return path;
	try {
		return realpath(path);
	} catch {
		// The target is already gone; keep the raw path so the
		// health check surfaces it rather than throwing here.
		return path;
	}
}
