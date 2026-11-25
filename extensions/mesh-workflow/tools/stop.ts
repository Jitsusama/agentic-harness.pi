/** mesh_stop: stopping a peer reaching this one, and saying who has. */

import { isAddress } from "../../../lib/mesh/address.ts";
import { groupNamed } from "../../../lib/mesh/group.ts";
import { oneLine } from "../../../lib/mesh/one-line.ts";
import type { stoppedBy } from "../../../lib/mesh/stop.ts";
import { type Answer, answer, type Local, tell } from "./local.ts";

/**
 * The stops on this peer, said to it a line each, with `after` closing
 * every line. A stopper gives its addresses and its reason as it likes,
 * and a reader takes each line as one stopper's and each sentence as
 * the tool's own. So each stop has a line of its own, opening on the
 * first of its stopper's addresses that is one, or on "A peer" when
 * none is, since a stop that bars a send is said either way; and its
 * reason is folded to that line and quoted as a string, which it can't
 * close to say a stop of another peer's after it.
 */
export function stopsText(
	stops: ReturnType<typeof stoppedBy>,
	after = "",
): string {
	return stops
		.map(({ stopper, stop }) => {
			const who = stopper.addresses.find(isAddress) ?? "A peer";
			const why =
				stop.why !== undefined && oneLine(stop.why) !== ""
					? `, saying ${JSON.stringify(oneLine(stop.why))}`
					: "";
			return `${who} stopped this peer reaching it${why}: it sees what this peer sends as one line only.${after}`;
		})
		.join("\n");
}

export async function stop(
	at: Local,
	params: { peer: string; why?: string; lift?: boolean },
): Promise<Answer> {
	const everyone = at.presences.all();
	const home = groupNamed(params.peer);
	const address = home?.startsWith("@") ? home.slice(1) : undefined;
	if (!address || at.peer.addresses.includes(address)) {
		return answer(
			`${params.peer} is not another peer's address; give one as mesh_groups lists it, such as P9R1KI.`,
		);
	}
	const why = params.why?.trim();
	const stopped = everyone.find((one) => one.addresses.includes(address));
	// Whichever of its addresses it is named by, a peer has one stop.
	const standing = at.peer.stops.find(
		(one) =>
			one.address === address ||
			(stopped !== undefined && one.session === stopped.session),
	);
	if (params.lift) {
		if (!standing) {
			return answer(`${address} is not stopped, so nothing changed.`);
		}
		at.peer.lift(standing.address);
		tell(
			at,
			address,
			`${at.peer.signature} has lifted its stop on this peer, which may reach it again as any peer does.`,
		);
		return answer(`Lifted the stop on ${address}; it is told.`);
	}
	if (standing) return answer(`${address} is stopped already.`);
	const set = at.peer.stop({
		address,
		at: new Date().toISOString(),
		...(stopped ? { session: stopped.session } : {}),
		...(why ? { why } : {}),
	});
	if (!set) return answer(`${address} is stopped already.`);
	tell(
		at,
		address,
		`${at.peer.signature} has stopped this peer reaching it${why ? `: ${why}` : "."} Until it lifts the stop, it sees what this peer sends as one line only, and sends to its home group are refused. Do not work around it.`,
	);
	return answer(
		`Stopped ${address}: what it sends reaches this peer as one line only, its answers to this peer's questions included, until mesh_stop with lift. It is told${why ? ", with why" : ""}.`,
	);
}
