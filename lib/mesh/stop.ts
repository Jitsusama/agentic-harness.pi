/**
 * Stops: a peer telling another to stop reaching it, which is absolute.
 *
 * Skynet's annals end on an objection that went unheard. An engineer got
 * six messages within ten seconds and answered that the list was too
 * much. The night filter, never lifted, appears to have held that, and
 * four minutes later the fleet edited a reply and uploaded a file
 * anyway; her "please stop" never reached it either, and the operator
 * stopped it by hand. The side that listened was set for the night
 * while the side that spoke was not. The requirements written after say
 * that a plain objection sets a stop toward whoever made it (R-3.3-5,
 * R-6.3-2 in the Skynet requirements register). So a stop
 * is the receiver's to set and the receiver's alone to lift, it lives
 * in the receiver's presence, and the receiver's own mesh enforces it,
 * so no sender, on whatever version of the harness, can get past it:
 *
 * - What the stopped peer sends reaches the stopper as a glance and
 *   nothing more, whatever it is and wherever it went: never in full,
 *   never a turn, never an invitation taken.
 * - Its sends to the stopper's home group are refused, and it is told
 *   when what it sends to a shared group reaches the stopper only so.
 *
 * Still a glance, never nothing: a peer cannot know what it stopped
 * hearing unless a line of it gets through, and mesh_read has the rest.
 */

import type { Message } from "./message.ts";
import type { Presence } from "./presence.ts";

/** One stop a peer has set. */
export interface Stop {
	/** The address the stopped peer signed with when it was stopped. */
	readonly address: string;
	/** The stopped peer's session, so a stop follows it to a new quest. */
	readonly session?: string;
	/** When it was set, as an ISO time. */
	readonly at: string;
	/** Why, as the stopper said it, for the stopped peer to read. */
	readonly why?: string;
}

/** The stops in a presence as read from outside, keeping the valid. */
export function stopsFrom(value: unknown): Stop[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((one): Stop[] => {
		if (typeof one !== "object" || one === null) return [];
		const stop = one as Record<string, unknown>;
		if (typeof stop.address !== "string" || typeof stop.at !== "string") {
			return [];
		}
		return [
			{
				address: stop.address,
				at: stop.at,
				...(typeof stop.session === "string" ? { session: stop.session } : {}),
				...(typeof stop.why === "string" ? { why: stop.why } : {}),
			},
		];
	});
}

/**
 * Whether one of these stops is on whoever sent this message: by the
 * address it signed with, or by any address the stopped session now
 * answers to.
 */
export function isStopped(
	message: Pick<Message, "from">,
	stops: readonly Stop[],
	everyone: readonly Presence[],
): boolean {
	return stops.some(
		(stop) =>
			stop.address === message.from ||
			(stop.session !== undefined &&
				everyone.some(
					(one) =>
						one.session === stop.session &&
						one.addresses.includes(message.from),
				)),
	);
}

/** The peers that have stopped this one, with the stop each set. */
export function stoppedBy(
	peer: Pick<Presence, "session" | "addresses">,
	everyone: readonly Presence[],
): { stopper: Presence; stop: Stop }[] {
	return everyone.flatMap((stopper) => {
		if (stopper.session === peer.session) return [];
		const stop = (stopper.stops ?? []).find(
			(one) =>
				one.session === peer.session || peer.addresses.includes(one.address),
		);
		return stop ? [{ stopper, stop }] : [];
	});
}
