/**
 * Damping: what a peer can afford of the attention messages deserve.
 *
 * Attention says what a message is worth to the peer it reaches (see
 * attention.ts); damping holds that to the peer's limits, so no sender
 * and no conversation can wear it out. Skynet's annals are the case for
 * it: on its second night it tagged 15 people 112 times, one engineer
 * got six messages within ten seconds, and each brake that lived in
 * prose was talked past. So the limits live here, in the receiver, and are
 * enforced rather than asked for:
 *
 * - Turns: the mesh starts at most {@link MOST_TURNS_AN_HOUR} turns of
 *   a peer an hour, and at most {@link MOST_TURNS_FROM_ONE} for any
 *   one sender, so one chatty peer cannot spend another's hour.
 * - Awaited: an answer to a question the peer asked starts its turn
 *   whatever the hour has spent, though the turn still counts, since
 *   the peer is waiting on it and is the one that asked. Depth and
 *   repeats still hold it back, so two peers cannot ask and answer
 *   each other past them.
 * - Depth: an answer more than {@link MOST_REPLY_DEPTH} deep never
 *   starts a turn, which ends two peers answering each other's answers.
 * - Repeats: what a sender already said, word for word, within the
 *   hour, is a glance, since the peer has it.
 *
 * A damped message is never dropped. One that would have started a
 * turn is noted instead, in full, with the next turn there is; a
 * repeat is glanced. Nor is the model ever told it was damped: an
 * agent shown its limits works to them (the swarm's agents, told their
 * share, quit with work undone), so damping is said on screen only.
 */

import type { Attention, Heed } from "./attention.ts";
import type { Message } from "./message.ts";

/** The most turns the mesh starts of one peer in an hour. */
export const MOST_TURNS_AN_HOUR = 12;

/** The most of those any one sender may start. */
export const MOST_TURNS_FROM_ONE = 6;

/** The deepest an answer may be and still start a turn. */
export const MOST_REPLY_DEPTH = 4;

/** How long the limits look back. */
export const HOUR_MS = 60 * 60 * 1000;

/** One turn the mesh started, and the senders it was for. */
export interface Turn {
	readonly at: number;
	readonly from: readonly string[];
}

/** One message handed over in full, for telling a repeat. */
export interface Said {
	readonly at: number;
	readonly from: string;
	readonly text: string;
}

/** What damping knows of a peer's last hour. */
export interface Damper {
	/** The attention a message gets, held to the peer's limits. */
	damp(message: Message, heed: Heed, depth: number, now?: number): Heed;
	/** Count a turn the mesh started, for these senders. */
	started(from: readonly string[], now?: number): void;
	/** Count messages handed over in full. */
	handed(messages: readonly Message[], now?: number): void;
	/** Take back what an earlier start of this session counted. */
	recover(turns: readonly Turn[], said: readonly Said[]): void;
}

const TURNS: readonly Attention[] = ["act", "wake"];

export function createDamper(): Damper {
	let turns: Turn[] = [];
	let said: Said[] = [];
	const forget = (now: number) => {
		turns = turns.filter((one) => now - one.at < HOUR_MS);
		said = said.filter((one) => now - one.at < HOUR_MS);
	};
	return {
		damp(message, heed, depth, now = Date.now()) {
			forget(now);
			if (
				heed.attention !== "glance" &&
				said.some(
					(one) => one.from === message.from && same(one.text, message.text),
				)
			) {
				return { attention: "glance", why: `${heed.why}, said already` };
			}
			if (!TURNS.includes(heed.attention)) return heed;
			const why =
				depth > MOST_REPLY_DEPTH
					? "an answer too deep in its thread"
					: heed.awaited
						? undefined
						: turns.length >= MOST_TURNS_AN_HOUR
							? "the hour's turns spent"
							: turns.filter((one) => one.from.includes(message.from)).length >=
									MOST_TURNS_FROM_ONE
								? `the hour's turns for ${message.from} spent`
								: undefined;
			return why ? { attention: "note", why: `${heed.why}, ${why}` } : heed;
		},
		started(from, now = Date.now()) {
			turns.push({ at: now, from: [...new Set(from)] });
		},
		handed(messages, now = Date.now()) {
			for (const message of messages) {
				said.push({ at: now, from: message.from, text: message.text });
			}
		},
		recover(before, saidBefore) {
			turns = [...before];
			said = [...saidBefore];
		},
	};
}

/** The same words, ignoring case and how they were spaced. */
function same(one: string, other: string): boolean {
	const plain = (text: string) =>
		text.trim().replace(/\s+/g, " ").toLowerCase();
	return plain(one) === plain(other);
}
