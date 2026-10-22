/**
 * Attention: how much of a peer a message gets, decided by the peer it
 * reaches and never none.
 *
 * The sender knows what a message is about, so it chooses who hears;
 * the receiver knows what it is doing, so it chooses how much attention
 * to pay. Most of what goes to `#all` is one peer's progress on its own
 * work ("merging core.nix#330"), and handed in full to every other peer
 * it spends their context on what they will never act on. The opposite
 * failure is a question sent to a peer that is idle: it sits unread
 * until the person next speaks ("sorry, I only just saw your mail",
 * twenty-two minutes later). And a message kept out of a peer entirely
 * is one it cannot know it missed.
 *
 * So a message gets one of three levels:
 *
 * - glance: another peer's own business. One line of it reaches the
 *   model with its next turn, beside any others, and mesh_read has the
 *   rest.
 * - note: in full, kept in mind, for what is sent to this peer, what
 *   concerns its work and what touches the whole machine.
 * - wake: in full and with a turn, for a question this peer is the one
 *   to answer while it is idle, since nothing else would get it read.
 *
 * Whether a message concerns a peer is a judgement, which a classifier
 * makes well when there is one (see {@link concernQuestion}). Without
 * one the answer falls back to what the words show: a message naming
 * this peer or something it owns concerns it, and anything else is
 * noted, because noting what did not matter costs a little context and
 * glancing past what did costs the work it was about.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import { isHomeTo, type Message } from "./message.ts";
import type { Presence } from "./presence.ts";

/** How much of a peer a message gets. */
export type Attention = "glance" | "note" | "wake";

/** Whose business a message is, from where its receiver stands. */
export type Concern = "receiver" | "machine" | "other";

/** What the receiver is, for judging what concerns it. */
export type Receiver = Pick<Presence, "addresses" | "worksOn" | "owns">;

/** Where the receiving peer stands when a message arrives. */
export interface Standing {
	readonly receiver: Receiver;
	/** Nothing is running, so the message would wait for the person. */
	readonly idle: boolean;
	/** The classifier's judgement, when one could be had. */
	readonly concern?: Concern;
}

/** The attention a message gets, and why, for the screen and the tests. */
export interface Heed {
	readonly attention: Attention;
	readonly why: string;
}

/**
 * Below this, a classifier's "not yours" is not trusted enough to give
 * a message only a glance. Noting one that turns out not to matter
 * costs a few lines; glancing past one that did costs the work.
 */
export const OTHER_AT_LEAST = 0.6;

/** The attention one message gets from a peer standing like this. */
export function attend(message: Message, at: Standing): Heed {
	const asked = at.idle && message.intent === "question";
	if (isHomeTo(message, at.receiver.addresses)) {
		return {
			attention: asked ? "wake" : "note",
			why: "sent to this peer",
		};
	}
	const concern =
		at.concern ?? (mentions(message, at.receiver) ? "receiver" : undefined);
	// A hold is noted whatever it is judged, since what it holds is
	// usually heavy work any peer may be about to start, and a hold
	// missed is the one mistake here that costs someone else.
	if (concern === "other" && message.intent !== "hold") {
		return { attention: "glance", why: "about another peer's own work" };
	}
	return {
		attention: asked && concern === "receiver" ? "wake" : "note",
		why:
			concern === "receiver"
				? "about this peer's work"
				: concern === "machine"
					? "about the whole machine"
					: "not judged, so noted",
	};
}

/**
 * Whether the message names this peer or something it owns, which is
 * what can be told without a classifier. Addresses are matched as words
 * and owned things as written, ignoring case, and anything shorter than
 * four letters is too common a word to count.
 */
export function mentions(
	message: Message,
	receiver: Pick<Receiver, "addresses" | "owns">,
): boolean {
	const text = message.text.toLowerCase();
	const named = receiver.addresses.some((address) =>
		new RegExp(`\\b${escapeRegExp(address.toLowerCase())}\\b`).test(text),
	);
	return (
		named ||
		receiver.owns.some(
			(owned) => owned.length >= 4 && text.includes(owned.toLowerCase()),
		)
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The question a classifier is asked, one call per message and peer.
 *
 * Asked as whose business the message is, with the three answers
 * concrete, because "does this concern the receiver" put to Jev came
 * back near even for all four messages it was tried on, and this
 * framing sorted six of six the way a person would.
 */
export const concernQuestion = {
	about: {
		type: "choice" as const,
		instructions:
			"Whose work is this message about, compared with what the receiving session works on and owns?",
		criteria: {
			receiver:
				"It is about what the receiving session works on or owns, or it names the receiving session",
			machine:
				"It affects every session on the machine: a reboot, a switch, network drops, or a hold on heavy work",
			other:
				"It is about another session's own work and asks nothing of the receiver",
		},
	},
};

/** What the classifier is shown: the receiver, and the message. */
export function concernState(
	message: Message,
	receiver: Receiver,
): ClassifierContext["state"] {
	return {
		receiver: {
			name: receiver.addresses[0] ?? "",
			works_on: receiver.worksOn,
			owns: [...receiver.owns],
		},
		message: {
			from: message.from,
			to: message.to.join(", "),
			intent: message.intent,
			text: message.text,
		},
	};
}

/**
 * The classifier's answer as a concern, or nothing when it gave none
 * worth acting on: a failed call, an unknown label, or a "not yours"
 * too unsure to glance on.
 */
export function concernFrom(answer: unknown): Concern | undefined {
	const about = answer as {
		type?: unknown;
		choice?: unknown;
		probabilities?: Record<string, number>;
	} | null;
	if (about?.type !== "choice") return undefined;
	const choice = about.choice;
	if (choice === "receiver" || choice === "machine") return choice;
	if (choice !== "other") return undefined;
	return (about.probabilities?.other ?? 0) >= OTHER_AT_LEAST
		? "other"
		: undefined;
}
