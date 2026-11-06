/**
 * Parked peers: sessions that ended idle to hold no memory, and are
 * started again by their holder when something needs them (see
 * internal/session/park.ts).
 *
 * A parked peer's process is gone, but its presence says `parked` while
 * its marker stands, and it is taken as there: what is sent to it rests
 * on disk until it starts again, as for any peer between runs. A sender
 * wakes it for a message that would give it a turn were it there and
 * idle: a question or hold sent to it, an answer to it, a pivot. Judged
 * as attention.ts judges for a receiver, without a classifier, so a
 * message noted or glanced at waits for its next start.
 */

import { attend } from "./attention.ts";
import { asksEach, type Message, reaches } from "./message.ts";
import type { Presence } from "./presence.ts";
import { answers, answersQuestion, type Reader } from "./thread.ts";

/** Whether a presence says its session is parked. */
export function saysParked(presence: Pick<Presence, "state">): boolean {
	return presence.state === "parked";
}

/**
 * Whether this message would give the parked peer a turn, were it
 * there. A pivot counts from anyone: who orchestrates it is read from
 * its quest, which a sender can't see, and waking one for a pivot that
 * proves not its orchestrator's costs one start.
 */
export function wakes(
	message: Message,
	parked: Presence,
	read: Reader,
): boolean {
	const listener = {
		addresses: parked.addresses,
		groups: parked.groups,
		...(parked.machine !== undefined ? { machine: parked.machine } : {}),
	};
	// Its process is gone, so no pid of a sender is its own.
	if (!reaches(message, listener, -1)) return false;
	if (message.intent === "pivot") return true;
	const self = { addresses: parked.addresses, pid: -1 };
	const heed = attend(message, {
		receiver: {
			addresses: parked.addresses,
			worksOn: parked.worksOn,
			owns: parked.owns,
		},
		idle: true,
		answers: answers(message, read, self),
		asked: answersQuestion(message, read, self),
		askedEach: asksEach(message, listener),
		now: Date.parse(message.at),
	});
	return heed.attention === "turn";
}

/**
 * Ask the holder of every parked peer this message would give a turn to
 * wake it; answers the sessions asked for.
 */
export function wakeParked(
	message: Message,
	everyone: readonly Presence[],
	read: Reader,
	isParked: (session: string) => boolean,
	askWake: (session: string, messageId: string) => void,
): string[] {
	const woken: string[] = [];
	for (const one of everyone) {
		if (!saysParked(one) || !isParked(one.session)) continue;
		if (!wakes(message, one, read)) continue;
		try {
			askWake(one.session, message.id);
			woken.push(one.session);
		} catch {
			// Unwoken, it reads the message at its next start all the same.
		}
	}
	return woken;
}
