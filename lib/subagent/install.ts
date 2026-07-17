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

/** A pinned pi install: the node binary, entry script and asset dir. */
export interface PiInstall {
	/** Absolute, dereferenced path to the node binary. */
	readonly node: string;
	/** Absolute, dereferenced path to the pi entry script. */
	readonly entry: string;
	/**
	 * Absolute, dereferenced value of the parent's
	 * `PI_PACKAGE_DIR`, when it is set. Pi resolves every
	 * bundled asset (the theme it loads at startup, its
	 * package.json, README) through `getPackageDir()`, which
	 * honours `PI_PACKAGE_DIR` before it self-locates from the
	 * entry script. Launchers that manage versioned installs
	 * (the Shopify nix wrapper, for one) point this at a
	 * `~/.pi/pkg/pi-<version>` symlink and delete the old
	 * symlink on upgrade. A child that inherits the raw value
	 * then reads its theme from a path the upgrade removed and
	 * crashes at startup. Dereferencing the symlink to its
	 * immutable store target at capture time pins the child's
	 * assets to the parent's exact install, which the running
	 * parent holds present for the whole session. `undefined`
	 * when the parent has no `PI_PACKAGE_DIR` (plain npm/brew
	 * installs self-locate from the entry script and need no
	 * override).
	 */
	readonly packageDir?: string;
}

/** Dependencies for {@link resolveParentPiInstall}. */
export interface ResolvePiInstallDeps {
	/** The parent's node binary, normally `process.execPath`. */
	readonly execPath: string;
	/** The parent's argv, normally `process.argv`. */
	readonly argv: readonly string[];
	/** Symlink dereferencing, normally `fs.realpathSync`. */
	readonly realpath: (p: string) => string;
	/**
	 * The parent's `PI_PACKAGE_DIR`, normally
	 * `process.env.PI_PACKAGE_DIR`. Undefined or empty when
	 * the parent self-locates from its entry script.
	 */
	readonly piPackageDir?: string;
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
	const piPackageDir =
		"piPackageDir" in deps ? deps.piPackageDir : process.env.PI_PACKAGE_DIR;
	const entryPath = argv[1] ?? "";
	return {
		node: dereference(execPath, realpath),
		entry: dereference(entryPath, realpath),
		...(piPackageDir
			? { packageDir: dereference(piPackageDir, realpath) }
			: {}),
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
