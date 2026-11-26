/**
 * What a host asks before a second conversation, and the root it runs.
 *
 * A host once ran a second conversation only after every live pi had
 * loaded a harness holding 5b5b7260 (#1129), whose mesh census judges
 * each hosted presence on its own, asking git of each pi's root. That
 * gate was retired on 26 November, when every live pi on both machines
 * held it, so a host now admits every conversation unless it is given
 * a gate: a child, which runs only its own, refuses a second
 * (child.ts's oneConversation), and tests give their own. The refusal
 * keeps the code `rollout_refused`, which clients already match.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The code a requester is refused under, with the gate's own words. */
export const ROLLOUT_REFUSED = "rollout_refused";

/** The package root this host runs, resolved through any link. */
export function hostRoot(): string {
	const root = fileURLToPath(new URL("../..", import.meta.url));
	try {
		return realpathSync(root);
	} catch {
		// A root that won't resolve is used as given, so the host still
		// starts: its version, its children's program and the install it
		// moves with are all read from the path as it was named.
		return root;
	}
}

/** What a second conversation comes in by: an open or adopt, or the wake of a parked one. */
export type Admitting = "open" | "wake";

/**
 * The check a host runs before a second conversation: resolves to admit
 * it, and rejects with words that fit what it admits (an open, unless
 * said).
 */
export type AdmitAnother = (admitting?: Admitting) => Promise<void>;
