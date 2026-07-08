/**
 * Process-global verification signal.
 *
 * The verification workflow writes its current fast-layer
 * outcome here so another extension can read whether the code
 * is failing without a shared import graph. The commit guardian
 * reads it to refuse a commit while checks are red.
 *
 * Stored on globalThis via Symbol.for so it is shared across
 * independently-loaded extensions without import-identity
 * issues. When the verification workflow is not loaded the value
 * stays false and readers see a clean signal.
 */

const FAILING_KEY = Symbol.for("pi:verification-failing");

type GlobalFailing = Record<symbol, boolean | undefined>;

/** Return true when the last verification pass found errors. */
export function isVerificationFailing(): boolean {
	return (globalThis as GlobalFailing)[FAILING_KEY] === true;
}

/** Record whether the last verification pass found errors. */
export function setVerificationFailing(failing: boolean): void {
	(globalThis as GlobalFailing)[FAILING_KEY] = failing;
}
