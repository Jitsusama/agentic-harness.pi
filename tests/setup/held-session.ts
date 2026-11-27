/**
 * Take a node's held session out of the environment a test inherits.
 *
 * A pi the node holds names its held session, realm and wake in
 * MYCELIUM_ variables, and a test inheriting them asks on the
 * developer's behalf, as an open asking the node for its held window
 * did. Every one goes, so one added tomorrow does too, and a test
 * wanting one sets it itself.
 *
 * A name the caller chose for the run, not one describing their session,
 * stays: `MYCELIUM_BIN` names the mycelium the host's end-to-end tests
 * drive, as the host's run script and the end-to-end README set it.
 */

/** The MYCELIUM_ names a caller sets for the run, which stay. */
export const CHOSEN_FOR_THE_RUN: ReadonlySet<string> = new Set([
	"MYCELIUM_BIN",
]);

/** Delete from `env` every MYCELIUM_ name but those chosen for the run. */
export function dropHeldSession(env: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(env)) {
		if (name.startsWith("MYCELIUM_") && !CHOSEN_FOR_THE_RUN.has(name))
			delete env[name];
	}
}
