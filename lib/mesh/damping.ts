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
 * - Addressed: a question or hold put to this peer is let past the
 *   hour's turns and its thread's depth. The orchestrator, which
 *   everyone asks, spent its twelve early and left questions waiting
 *   for the person.
 * - Questions: a question that would start a turn always does, whatever
 *   the hour, its depth or its words. On 2026-10-25 at 23:20 a question
 *   the orchestrator put to one idle peer sat unstarted, as "an answer
 *   too deep in its thread", while Joel watched it wait: a question is
 *   the one message whose sender is parked on the answer.
 * - Depth: any other answer more than {@link MOST_REPLY_DEPTH} deep never
 *   starts a turn, which ends two peers answering each other's answers.
 * - Repeats: what a sender already said, word for word, within the
 *   hour, is a glance, since the peer has it. The same message handed
 *   again is no repeat: it comes back because it needs more than it
 *   had, such as a question the peer answering it let go.
 * - News: once one sender has had {@link MOST_IN_FULL_FROM_ONE} of its
 *   messages handed over in full within the hour, its next fyi is a
 *   glance. Turns are limited, but a note mid-run costs the peer its
 *   reading too, and Skynet's six messages in ten seconds were each
 *   read. An answer the peer waits on is never held back this way.
 * - Catch-up: a peer starting with more than {@link MOST_CAUGHT_UP}
 *   messages to take in is handed in full only the newest of them,
 *   what is addressed to it, what answers it and what holds; the rest
 *   are glances. A session back from a night away would otherwise
 *   start its work under a night of other peers' news.
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

/** The most of one sender's messages handed over in full in an hour. */
export const MOST_IN_FULL_FROM_ONE = 10;

/** The most of a catch-up handed over in full, newest first. */
export const MOST_CAUGHT_UP = 20;

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
	/** The message it was, so that message handed again is told apart. */
	readonly id?: string;
}

/** What damping knows of a peer's last hour. */
export interface Damper {
	/**
	 * The attention a message gets, held to the peer's limits; `earlier`
	 * are the messages before it in the same arrival that are handed
	 * over in full, which count as though already handed.
	 */
	damp(
		message: Message,
		heed: Heed,
		depth: number,
		now?: number,
		earlier?: readonly Message[],
	): Heed;
	/** Count a turn the mesh started, for these senders. */
	started(from: readonly string[], now?: number): void;
	/** Count messages handed over in full. */
	handed(messages: readonly Message[], now?: number): void;
	/** Take back what an earlier start of this session counted. */
	recover(turns: readonly Turn[], said: readonly Said[]): void;
}

const TURNS: readonly Attention[] = ["act", "turn"];

export function createDamper(): Damper {
	let turns: Turn[] = [];
	let said: Said[] = [];
	const forget = (now: number) => {
		turns = turns.filter((one) => now - one.at < HOUR_MS);
		said = said.filter((one) => now - one.at < HOUR_MS);
	};
	return {
		damp(message, heed, depth, now = Date.now(), earlier = []) {
			forget(now);
			if (message.intent === "question" && TURNS.includes(heed.attention)) {
				return heed;
			}
			if (
				heed.attention !== "glance" &&
				said.some(
					(one) =>
						one.id !== message.id &&
						one.from === message.from &&
						same(one.text, message.text),
				)
			) {
				return { attention: "glance", why: `${heed.why}, said already` };
			}
			if (
				message.intent === "fyi" &&
				heed.attention !== "glance" &&
				!heed.awaited &&
				inFullFrom(message, said, earlier) >= MOST_IN_FULL_FROM_ONE
			) {
				return {
					attention: "glance",
					why: `${heed.why}, the hour's news from ${message.from} spent`,
				};
			}
			if (!TURNS.includes(heed.attention)) return heed;
			const why = heed.addressed
				? undefined
				: depth > MOST_REPLY_DEPTH
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
				said.push({
					at: now,
					from: message.from,
					text: message.text,
					id: message.id,
				});
			}
		},
		recover(before, saidBefore) {
			turns = [...before];
			said = [...saidBefore];
		},
	};
}

/**
 * How many of a sender's other messages were handed over in full this
 * hour, each counted once however often it came back.
 */
function inFullFrom(
	message: Message,
	said: readonly Said[],
	earlier: readonly Message[],
): number {
	const ids = new Set<string>();
	let unnamed = 0;
	for (const one of [...said, ...earlier]) {
		if (one.from !== message.from || one.id === message.id) continue;
		if (one.id === undefined) unnamed += 1;
		else ids.add(one.id);
	}
	return ids.size + unnamed;
}

/** One message of a catch-up, with whether it is this peer's own business. */
export interface CaughtUp {
	readonly message: Message;
	readonly heed: Heed;
	/** Addressed to the peer, answering it, or a hold: never held back. */
	readonly own: boolean;
}

/**
 * A catch-up held to what a peer starting can take in: past the newest
 * {@link MOST_CAUGHT_UP} handed over in full, what is not its own
 * business is a glance. `caught` is in the order the messages came.
 */
export function caughtUp(caught: readonly CaughtUp[]): Heed[] {
	let kept = 0;
	const heeds: Heed[] = [];
	for (let at = caught.length - 1; at >= 0; at -= 1) {
		const { heed, own } = caught[at] as CaughtUp;
		if (heed.attention === "glance" || own) {
			heeds.unshift(heed);
		} else if (kept < MOST_CAUGHT_UP) {
			kept += 1;
			heeds.unshift(heed);
		} else {
			heeds.unshift({
				attention: "glance",
				why: `${heed.why}, older in a long catch-up`,
			});
		}
	}
	return heeds;
}

/** The same words, ignoring case and how they were spaced. */
function same(one: string, other: string): boolean {
	const plain = (text: string) =>
		text.trim().replace(/\s+/g, " ").toLowerCase();
	return plain(one) === plain(other);
}
