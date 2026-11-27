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

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { hosted } from "../core/session/index.ts";

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
	/**
	 * Whether `dir` is a package's root, normally whether it holds a
	 * `package.json`: how the entry script's own package is found when
	 * `PI_PACKAGE_DIR` names a link an upgrade removed.
	 */
	readonly holdsPackage?: (dir: string) => boolean;
}

/** Whether `dir` holds a package.json, so is a package's root. */
function holdsPackageJson(dir: string): boolean {
	return existsSync(join(dir, "package.json"));
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
 * health check can report it as gone. A `PI_PACKAGE_DIR`
 * that won't resolve is first looked for from the entry
 * script, which runs inside the very package the link named:
 * the nearest folder above it that holds a package.json.
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
	const holdsPackage = deps.holdsPackage ?? holdsPackageJson;
	const entryPath = argv[1] ?? "";
	const entry = dereference(entryPath, realpath);
	return {
		node: dereference(execPath, realpath),
		entry,
		...(piPackageDir
			? {
					packageDir:
						resolved(piPackageDir, realpath) ??
						packageOf(entry, holdsPackage) ??
						piPackageDir,
				}
			: {}),
	};
}

/**
 * The package root the entry script at `entry` sits in: the nearest
 * folder above it that `holdsPackage` says is one, or undefined when
 * none is, up to the file system's root.
 */
function packageOf(
	entry: string,
	holdsPackage: (dir: string) => boolean,
): string | undefined {
	if (!entry) return undefined;
	let dir = dirname(entry);
	while (true) {
		if (holdsPackage(dir)) return dir;
		const up = dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
}

/**
 * Symbol under which the startup install snapshot is stashed on
 * `globalThis`. Pi loads extensions with jiti's module cache
 * disabled, so a `/reload` re-evaluates this module and would
 * recompute a module-level constant, since after a mid-session
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
	if (existing !== undefined) {
		const healed = healedInstall(existing);
		if (healed !== existing) store[STARTUP_INSTALL_KEY] = healed;
		return healed;
	}
	if (hosted()) {
		throw new Error(
			"Hosted subagents need the host to pin pi.subagent.startupPiInstall to pi's CLI before loading extensions",
		);
	}
	const install = resolveParentPiInstall();
	store[STARTUP_INSTALL_KEY] = install;
	return install;
}

/**
 * `install`, or, when the package folder it names is gone, the same
 * install with the package its entry script sits in, which is also
 * put in `PI_PACKAGE_DIR` so pi itself reads its assets from there.
 * A pi that captured its install with the link already gone, or under
 * code that kept a dead link, heals so at its next dispatch.
 */
function healedInstall(install: PiInstall): PiInstall {
	const { packageDir } = install;
	if (packageDir === undefined || existsSync(packageDir)) return install;
	const found = packageOf(
		dereference(install.entry, realpathSync),
		holdsPackageJson,
	);
	if (found === undefined) return install;
	const root = dereference(found, realpathSync);
	process.env.PI_PACKAGE_DIR = root;
	return { ...install, packageDir: root };
}

function dereference(path: string, realpath: (p: string) => string): string {
	return resolved(path, realpath) ?? path;
}

/** `path` dereferenced, or undefined when empty or its target is gone. */
function resolved(
	path: string,
	realpath: (p: string) => string,
): string | undefined {
	if (!path) return undefined;
	try {
		return realpath(path);
	} catch {
		// The target is already gone; the caller decides what stands in.
		return undefined;
	}
}
