/**
 * Process-global bypass state for git command interception.
 *
 * Stored on globalThis via Symbol.for so it's shared across
 * independently-loaded extensions without import identity
 * issues. If the toggle extension isn't loaded, the value
 * stays false and everything works normally.
 */

const BYPASS_KEY = Symbol.for("pi:git-bypass");

type GlobalBypass = Record<symbol, boolean | undefined>;

/** Return true when git interception is bypassed. */
export function isGitBypassed(): boolean {
	return (globalThis as GlobalBypass)[BYPASS_KEY] === true;
}

/** Set the git interception bypass state. */
export function setGitBypassed(bypassed: boolean): void {
	(globalThis as GlobalBypass)[BYPASS_KEY] = bypassed;
}
