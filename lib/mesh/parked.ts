/**
 * Parked peers: sessions that ended idle to hold no memory, and are
 * started again by their holder when something needs them (see
 * internal/session/park.ts).
 *
 * A parked peer's process is gone, but its presence says `parked` while
 * its marker stands, and it is taken as there: what is sent to it rests
 * on disk until it starts again, as for any peer between runs. A sender
 * wakes it for a message that would give it a turn were it there and
 * idle: a question or hold sent to it, an answer to it, a pivot, and
 * for an orchestrator a finding or news sent to it by a session it
 * leads. Judged as attention.ts judges for a receiver, without a
 * classifier, so a message noted or glanced at waits for its next start.
 *
 * A steer is read as the peer starts. A talk wakes it, since a running
 * peer would answer at once and the person is waiting: a parked void
 * left Joel's lines in its inbox until something else started it (12
 * Nov 2026). One that closes it or carries its work to another machine
 * can only be done by the peer running, and whoever asked is waiting on
 * it: mycelium waits for a carried session's done file before it
 * carries the rest. So a peer that looks about it wakes a parked peer
 * whose inbox holds either, through the same holder. A pause or stop
 * does nothing to a peer that isn't running, so it waits.
 */

import { attend } from "./attention.ts";
import { asksEach, type Message, reaches } from "./message.ts";
import type { Presence } from "./presence.ts";
import { inboxOf, type Steer, waitingSteers } from "./steer.ts";
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
	sender?: Pick<Presence, "orchestratedBy">,
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
	const led =
		sender?.orchestratedBy !== undefined &&
		parked.addresses.includes(sender.orchestratedBy);
	const heed = attend(message, {
		receiver: {
			addresses: parked.addresses,
			worksOn: parked.worksOn,
			owns: parked.owns,
		},
		idle: true,
		...(led ? { led: true } : {}),
		answers: answers(message, read, self),
		asked: answersQuestion(message, read, self),
		askedEach: asksEach(message, listener),
		now: Date.parse(message.at),
	});
	// What it leads acts on once the mesh settles: a turn all the same.
	return heed.attention === "turn" || (led && heed.attention === "act");
}

/**
 * Whether a steer waits on its parked peer running: a talk, or a resume
 * with words, which a running peer answers; a close, a carry or a move,
 * which only a running session can make; or a fill, since the person is
 * coming to its window to send it.
 */
function steerWakes(steer: Steer): boolean {
	return (
		steer.act === undefined ||
		(steer.act === "resume" && steer.text !== "") ||
		steer.act === "close" ||
		steer.act === "carry" ||
		steer.act === "move" ||
		steer.act === "fill"
	);
}

/**
 * Ask the holder of every parked peer whose steer inbox under `root`
 * holds a talk, a close, a carry, a move or a fill to wake it, the
 * steer's file named as why;
 * answers the sessions asked for. The steer stays where it is, for the
 * peer to take as it starts.
 */
export function wakeSteered(
	everyone: readonly Presence[],
	root: string,
	isParked: (session: string) => boolean,
	askWake: (session: string, why: string) => void,
): string[] {
	const woken: string[] = [];
	for (const one of everyone) {
		if (!saysParked(one) || !isParked(one.session)) continue;
		const waking = one.addresses
			.flatMap((address) => waitingSteers(inboxOf(root, address)))
			.find(steerWakes);
		if (waking === undefined) continue;
		try {
			askWake(one.session, `steer-${waking.file}`);
			woken.push(one.session);
		} catch {
			// Unwoken, it takes the steer at its next start all the same.
		}
	}
	return woken;
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
	const sender = everyone.find((one) => one.addresses.includes(message.from));
	for (const one of everyone) {
		if (!saysParked(one) || !isParked(one.session)) continue;
		if (!wakes(message, one, read, sender)) continue;
		try {
			askWake(one.session, message.id);
			woken.push(one.session);
		} catch {
			// Unwoken, it reads the message at its next start all the same.
		}
	}
	return woken;
}
