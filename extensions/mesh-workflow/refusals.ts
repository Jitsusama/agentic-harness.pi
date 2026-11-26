/**
 * What the mesh's tools say of a parked peer whose host refused its last
 * wake, as its host keeps it (lib/internal/session/refused-wake.ts).
 *
 * A sender wakes a parked hosted peer through its wake file, and a host
 * may refuse: at the gate a second conversation passes, or as it stops.
 * On 11 November H2 found that only the host's log said so, and the
 * sender, and every sender after, heard nothing of why the peer slept on.
 * So mesh_send says it of a peer it addresses, mesh_groups lists each
 * with its reason, and the unanswered list marks a question waiting on
 * one.
 */

import type { RefusedWake } from "../../lib/internal/session/refused-wake.ts";
import { isAddress } from "../../lib/mesh/address.ts";
import { clock } from "../../lib/mesh/message.ts";
import { oneLine } from "../../lib/mesh/one-line.ts";
import type { Presence } from "../../lib/mesh/presence.ts";

/** A parked peer's refused wake, when its host keeps one. */
export type Refusal = (presence: Presence) => RefusedWake | undefined;

/**
 * A refusal's reason as one sentence on one line, whether or not it
 * ended in a stop. The reason is read from beside the wake path the
 * parked peer's own presence names, and a host may keep an error's
 * message there, so it may come on any number of lines.
 */
function sentence(refused: RefusedWake): string {
	const reason = oneLine(refused.reason);
	return reason.endsWith(".") ? reason : `${reason}.`;
}

/** What a send says of each peer it addresses whose host refused its last wake. */
export function refusedNotes(
	addressed: readonly Presence[],
	refusal: Refusal,
): string[] {
	return addressed.flatMap((one) => {
		const refused = refusal(one);
		// A presence's addresses are read in an address's shape, which
		// `person` and `machine` have too, and this opens the note.
		const address = one.addresses.find(isAddress);
		if (!refused || address === undefined) return [];
		return [
			`${address} is parked, and its host refused its last wake at ${clock(refused)}: ${sentence(refused)} If that still holds, it reads this at its next start.`,
		];
	});
}

/** mesh_groups' list of the parked peers whose last wake was refused, and why. */
export function refusedSection(
	present: readonly Presence[],
	refusal: Refusal,
): string {
	const lines = present.flatMap((one) => {
		const refused = refusal(one);
		const address = one.addresses[0];
		return refused && address !== undefined
			? [`${address} at ${clock(refused)}: ${sentence(refused)}`]
			: [];
	});
	return lines.length > 0
		? `\nParked, their last wake refused:\n${lines.join("\n")}`
		: "";
}

/** How the unanswered list marks a peer it waits on whose last wake was refused. */
export function refusedMark(refused: RefusedWake | undefined): string {
	return refused ? ` (parked, its last wake refused at ${clock(refused)})` : "";
}
