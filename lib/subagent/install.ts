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
	 * store target at startup pins the child's assets to the
	 * parent's exact install: a symlink rotation on upgrade
	 * cannot move it, and the running parent keeps the store
	 * target present under normal operation. An explicit store
	 * garbage-collection can still remove it out from under a
	 * live session, which is why the health check re-probes
	 * this path rather than trusting it forever. `undefined`
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
 * Compute the parent's running pi install as dereferenced
 * absolute paths. The node binary comes from `execPath`, the
 * entry script from `argv[1]` and the asset dir from
 * `PI_PACKAGE_DIR`, each passed through `realpath` so a later
 * profile repoint or symlink deletion cannot move them.
 *
 * This is a pure probe: it reads the environment and the file
 * system every call and never caches. Production code wants
 * the startup capture instead, which pins the paths before a
 * mid-session upgrade can delete them; use
 * {@link getParentPiInstall} for that. This function stays
 * for tests and for any consumer that deliberately wants a
 * fresh reading of the current environment.
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
	// `in`, not `??`: a caller that passes `piPackageDir: undefined`
	// is declaring the parent has no PI_PACKAGE_DIR, which must not
	// fall through to `process.env`. `??` cannot tell that explicit
	// undefined from an absent key.
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

/**
 * Symbol under which the startup install snapshot is stashed on
 * `globalThis`. Pi loads extensions with jiti's module cache
 * disabled, so a `/reload` re-evaluates this module and would
 * recompute a module-level constant — after a mid-session
 * upgrade that could recapture a now-deleted symlink. A
 * `Symbol.for` key on `globalThis` outlives module
 * re-evaluation (same process, same realm), so the first
 * capture, taken at true process startup before any upgrade,
 * is the one every later reload and every extension instance
 * reuses.
 */
const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

type StartupInstallGlobal = {
	[STARTUP_INSTALL_KEY]?: PiInstall;
};

/**
 * The parent's install, captured once at process startup and
 * reused for the whole session.
 *
 * Extensions resolve the install lazily, on the first subagent
 * dispatch, which can land minutes into a session after a
 * mid-session upgrade has already deleted the versioned
 * `~/.pi/pkg/pi-<version>` symlink that `PI_PACKAGE_DIR` names.
 * Dereferencing then would throw and fall back to the dead
 * path, re-opening the crash the pin exists to prevent. This
 * accessor takes the reading once, stashes it on `globalThis`
 * so a `/reload` cannot recapture a stale value, and hands the
 * same immutable snapshot to every caller thereafter. The
 * first call must happen before any upgrade; module load at
 * extension registration (session start) and the health
 * check's own startup probe both satisfy that.
 */
export function getParentPiInstall(): PiInstall {
	const store = globalThis as StartupInstallGlobal;
	const existing = store[STARTUP_INSTALL_KEY];
	if (existing !== undefined) return existing;
	const install = resolveParentPiInstall();
	store[STARTUP_INSTALL_KEY] = install;
	return install;
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
