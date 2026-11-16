/**
 * The harness's files in a carry an orchestrator orders, as mycelium
 * reads them (its PROTOCOL.md, A Carry an Orchestrator Orders).
 *
 * A session the node steers `ordered-carry` may refuse, saying why, as
 * ISXEG8's condition 4 asks (15 November): it writes
 * `<session>.refused.json` in the handover folder its done file would go
 * in, holding only `session`, `why` and `at`, so mycelium fails fast
 * rather than waiting out its quarter hour, and counts it only when it
 * is no older than the order. Nothing of the steer is copied into it.
 *
 * A session carried that way is told on arrival who carried it and why,
 * as condition 3 asks, by a steer of its own from the machine's
 * pi-carry, never as the person: `pi-carry arrive --by --why` writes it
 * once the session's work is in place.
 */

import { join } from "node:path";
import { sessionAddress } from "../../mesh/address.ts";
import { FROM_MACHINE, giveSteer } from "../../mesh/steer.ts";
import { writeWhole } from "../write-whole.ts";

/** Where a session's refusal goes, beside where its done file would. */
export function refusedFileOf(handover: string, session: string): string {
	return join(handover, `${session}.refused.json`);
}

/** A session's refusal of an ordered carry. */
export interface Refusal {
	readonly session: string;
	readonly why: string;
	readonly at: Date;
}

/** Writes a session's refusal whole into `handover`, answering its path. */
export function writeRefused(handover: string, refusal: Refusal): string {
	const file = refusedFileOf(handover, refusal.session);
	writeWhole(
		file,
		`${JSON.stringify({
			session: refusal.session,
			why: refusal.why,
			at: refusal.at.toISOString(),
		})}\n`,
	);
	return file;
}

/** Who carried a session here, and why, as the node stamped it. */
export interface CarriedBy {
	readonly session: string;
	/** The machine it left. */
	readonly from: string;
	/** The orchestrator's address that ordered it. */
	readonly by: string;
	readonly why: string;
}

/** The program a machine steer names as its writer here. */
const PI_CARRY = "pi-carry";

/**
 * Tells the arriving session, through its own steer inbox under `root`,
 * who carried it and why, as the machine's pi-carry rather than the
 * person; answers the steer's file name.
 */
export function tellCarried(root: string, carried: CarriedBy): string {
	return giveSteer(root, sessionAddress(carried.session), {
		text: `This session was carried here from ${carried.from} by ${carried.by}, for ${carried.why}. The person didn't carry it: ${carried.by}, the orchestrator above its quest, ordered it, and the mycelium node checked that it may. Carry on where you left off.`,
		from: FROM_MACHINE,
		by: PI_CARRY,
		at: new Date().toISOString(),
	});
}
