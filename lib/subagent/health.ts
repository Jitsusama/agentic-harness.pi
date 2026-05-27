/**
 * Pre-dispatch and post-dispatch health checks for the
 * subagent runtime.
 *
 * When pi is updated mid-session (e.g. a nix profile
 * upgrade replaces the package, or brew installs a new
 * version over the running one) the parent process keeps
 * running from a path that no longer exists on disk.
 * Subagents spawned with parent-derived extension paths
 * fail to load and crash with `ENOENT` on a path inside
 * `/.pi/pkg/pi-X.Y.Z/`. The condition is session-fatal
 * — no retry succeeds until the user restarts pi.
 *
 * This module provides two complementary detectors so the
 * dispatcher can replace the misleading "retry" hint with
 * a clear "restart pi" advisory:
 *
 *   - `createSubagentHealthCheck` probes the running pi
 *     binary path before dispatch. The default instance
 *     is bound to `process.execPath` and `fs.existsSync`;
 *     tests inject fakes.
 *
 *   - `detectStaleInstallInStderr` matches the ENOENT
 *     shape every failing subagent emits and returns the
 *     same actionable message. Catches paths the
 *     pre-dispatch probe doesn't know about (extension
 *     resolution, native binaries, etc.).
 */

import { existsSync } from "node:fs";

/**
 * Stable prefix every consumer can grep on to detect the
 * stale-runtime warning. Downstream summary renderers use
 * this to swap the per-reviewer retry hint for a single
 * session-level advisory.
 */
export const STALE_RUNTIME_WARNING_PREFIX = "Pi runtime stale:";

/** Structured error describing a stale subagent runtime. */
export interface SubagentRuntimeError {
	readonly path: string;
	readonly message: string;
}

/** Dependencies for `createSubagentHealthCheck`. */
export interface SubagentHealthDeps {
	readonly runtimePath: string;
	readonly exists: (path: string) => boolean;
}

/**
 * Build a health check bound to a captured runtime path.
 *
 * The check runs the existence probe at most once per
 * factory and memoises the answer. Pi cannot restore a
 * deleted nix store entry (or brew cellar entry) without
 * restarting itself, so re-stat'ing on every dispatch
 * would burn syscalls for no signal.
 */
export function createSubagentHealthCheck(
	deps: SubagentHealthDeps,
): () => SubagentRuntimeError | null {
	let cached: SubagentRuntimeError | null | undefined;
	return () => {
		if (cached !== undefined) return cached;
		if (deps.exists(deps.runtimePath)) {
			cached = null;
			return null;
		}
		cached = {
			path: deps.runtimePath,
			message:
				`${STALE_RUNTIME_WARNING_PREFIX} the running pi binary at ` +
				`\`${deps.runtimePath}\` no longer exists on disk. Pi was likely ` +
				"updated (nix gc, brew upgrade, etc.) mid-session; restart pi to " +
				"load the new binary. Subagent dispatch will fail until you do.",
		};
		return cached;
	};
}

/**
 * Default singleton bound to the running pi process.
 *
 * Captured at module load. Production code uses this; the
 * factory above stays exported for tests and any consumer
 * that wants a fresh probe.
 */
export const checkSubagentRuntime: () => SubagentRuntimeError | null =
	createSubagentHealthCheck({
		runtimePath: process.execPath,
		exists: existsSync,
	});

/**
 * Pattern that matches the canonical "stale pi install"
 * ENOENT shape: an absolute path containing `.pi/pkg/pi-`
 * followed by a semver-shaped version segment. Reliable
 * across Node's stderr formatting and pi's own error
 * surfaces because the directory naming convention is
 * stable.
 */
const STALE_PI_PKG_PATH =
	/ENOENT[^\n]*?(['"`])?(\S*?\.pi\/pkg\/pi-\d+\.\d+\.\d+[^\s'"`)]*)/;

/**
 * Detect the stale-install signature in a subagent's
 * stderr and return an actionable message.
 *
 * Returns null when the stderr doesn't match — callers
 * fall back to the regular non-zero-exit warning shape.
 */
export function detectStaleInstallInStderr(stderr: string): string | null {
	if (!stderr) return null;
	const match = STALE_PI_PKG_PATH.exec(stderr);
	if (!match) return null;
	const path = match[2];
	return (
		`${STALE_RUNTIME_WARNING_PREFIX} subagent crashed loading \`${path}\`, ` +
		"which no longer exists. Pi was likely updated mid-session; restart pi " +
		"to recover. Retrying will keep failing until you do."
	);
}
