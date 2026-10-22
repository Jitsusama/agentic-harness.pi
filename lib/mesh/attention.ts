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
 * So a message gets one of four levels:
 *
 * - glance: another peer's own business. One line of it reaches the
 *   model with its next turn, beside any others, and mesh_read has the
 *   rest.
 * - note: in full, kept in mind, for what is sent to this peer, what
 *   concerns its work and what touches the whole machine. A peer mid-run
 *   reads it before its next step; an idle one with its next turn.
 * - act: in full, and a turn of its own once the mesh has settled, for
 *   what an idle peer should act on but need not drop everything for: a
 *   finding sent to it, or a question to a group about its work, which
 *   whichever peer answers first settles for the rest.
 * - wake: in full and a turn at once, for a question sent to this idle
 *   peer, or answering one it asked, since someone is waiting on it.
 *
 * A message answering one this peer sent is taken as sent to it, since
 * it is, wherever it went. An fyi or a hold never takes a turn: neither
 * asks for anything an idle peer has to do. The exception is an answer
 * to a question this peer asked, which wakes it however it was sent,
 * since the peer is waiting on it: an answer sent as an fyi would
 * otherwise sit until something else started a turn. Any other fyi more
 * than {@link FYI_MS} old when it reaches the peer is a glance, and so is
 * a hold older than the longest a hold stands ({@link MOST_HOLD_MS}),
 * which no longer holds anything.
 *
 * What a message is worth is held to what the peer can afford by
 * damping (see damping.ts), which this module knows nothing of.
 *
 * Whether a message concerns a peer is a judgement, which a classifier
 * makes well when there is one (see {@link concernQuestion}). Without
 * one the answer falls back to what the words show: a message naming
 * this peer, something it owns or a file it is changing concerns it, and
 * anything else is noted, because noting what did not matter costs a
 * little context and glancing past what did costs the work it was about.
 *
 * What a peer is changing now is what most tells its business from
 * another's. Asked without it, Jev put four of four "merging core #366"
 * fyis at 0.50 to 0.56 "not yours", too unsure to glance on, so every
 * peer on #optimus took each in full; shown it, the same four came back
 * at 0.73 to 0.81, and two messages about files the peer was changing
 * at 0.93 and 0.94 its own (see {@link concernQuestionFor}).
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import { MOST_HOLD_MS } from "./lease.ts";
import { isHomeTo, type Message } from "./message.ts";
import type { Presence } from "./presence.ts";

/** How much of a peer a message gets. */
export type Attention = "glance" | "note" | "act" | "wake";

/** Whose business a message is, from where its receiver stands. */
export type Concern = "receiver" | "machine" | "other";

/** What the receiver is, for judging what concerns it. */
export type Receiver = Pick<Presence, "addresses" | "worksOn" | "owns"> & {
	/** What it is changing now, as its change leases name it (`repo:path`). */
	readonly changing?: readonly string[];
};

/** Where the receiving peer stands when a message arrives. */
export interface Standing {
	readonly receiver: Receiver;
	/** Nothing is running, so the message would wait for the person. */
	readonly idle: boolean;
	/** The classifier's judgement, when one could be had. */
	readonly concern?: Concern;
	/** The message answers one this peer sent (see thread.ts). */
	readonly answers?: boolean;
	/** The message answers a question this peer asked (see thread.ts). */
	readonly asked?: boolean;
	/** The time it is handed over, for judging an fyi or a hold past its time. */
	readonly now?: number;
}

/** The attention a message gets, and why, for the screen and the tests. */
export interface Heed {
	readonly attention: Attention;
	readonly why: string;
	/**
	 * The peer is waiting on it, as on an answer to its own question, so
	 * damping does not hold it to the hour's turns.
	 */
	readonly awaited?: boolean;
}

/**
 * Below this, a classifier's "not yours" is not trusted enough to give
 * a message only a glance. Noting one that turns out not to matter
 * costs a few lines; glancing past one that did costs the work.
 */
export const OTHER_AT_LEAST = 0.6;

/**
 * How long an fyi is news. Past it, one reaching a peer (after a
 * reload, mostly, or a long run) is a glance wherever it went, since
 * what it told has moved on; Skynet's register gives fyis an hour.
 */
export const FYI_MS = 60 * 60 * 1000;

/** The attention one message gets from a peer standing like this. */
export function attend(message: Message, at: Standing): Heed {
	if (at.asked) {
		const why = "answering this peer's question";
		return at.idle
			? { attention: "wake", why, awaited: true }
			: { attention: "note", why };
	}
	if (
		message.intent === "fyi" &&
		at.now !== undefined &&
		at.now - Date.parse(message.at) > FYI_MS
	) {
		return { attention: "glance", why: "an fyi past its hour" };
	}
	if (
		message.intent === "hold" &&
		at.now !== undefined &&
		at.now - Date.parse(message.at) > MOST_HOLD_MS
	) {
		return { attention: "glance", why: "a hold past the longest one stands" };
	}
	if (at.answers || isHomeTo(message, at.receiver.addresses)) {
		const why = at.answers ? "answering this peer" : "sent to this peer";
		if (!at.idle) return { attention: "note", why };
		if (message.intent === "question") return { attention: "wake", why };
		if (message.intent === "finding") return { attention: "act", why };
		return { attention: "note", why };
	}
	const concern =
		at.concern ?? (mentions(message, at.receiver) ? "receiver" : undefined);
	// A hold is noted whatever it is judged, since what it holds is
	// usually heavy work any peer may be about to start, and a hold
	// missed is the one mistake here that costs someone else.
	if (concern === "other" && message.intent !== "hold") {
		return { attention: "glance", why: "about another peer's own work" };
	}
	const acts =
		at.idle &&
		concern === "receiver" &&
		(message.intent === "question" || message.intent === "finding");
	return {
		attention: acts ? "act" : "note",
		why:
			concern === "receiver"
				? "about this peer's work"
				: concern === "machine"
					? "about the whole machine"
					: "not judged, so noted",
	};
}

/**
 * Whether the message names this peer, something it owns or a file it is
 * changing, which is what can be told without a classifier. Addresses are
 * matched as words, owned things as written and files by their path,
 * ignoring case. Anything shorter than four letters is too common a word
 * to count, and so is a file at a checkout's top (`flake.nix`,
 * `README.md`), which every repository has.
 */
export function mentions(
	message: Pick<Message, "text">,
	receiver: Pick<Receiver, "addresses" | "owns" | "changing">,
): boolean {
	const text = message.text.toLowerCase();
	const named = receiver.addresses.some((address) =>
		new RegExp(`\\b${escapeRegExp(address.toLowerCase())}\\b`).test(text),
	);
	const paths = (receiver.changing ?? []).map((subject) =>
		subject.slice(subject.indexOf(":") + 1).toLowerCase(),
	);
	return (
		named ||
		receiver.owns.some(
			(owned) => owned.length >= 4 && text.includes(owned.toLowerCase()),
		) ||
		paths.some((path) => path.includes("/") && text.includes(path))
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

/**
 * The question asked of a peer that is changing something: the same
 * three answers, with what it changes now beside what it works on.
 */
export const concernQuestionNow = {
	about: {
		type: "choice" as const,
		instructions:
			"Whose work is this message about, compared with what the receiving session works on, owns and is changing now?",
		criteria: {
			...concernQuestion.about.criteria,
			receiver:
				"It is about what the receiving session works on, owns or is changing now, or it names the receiving session",
		},
	},
};

/**
 * The question for this receiver. Only one changing something is asked
 * about what it changes: asked of a peer changing nothing, that question
 * put a message about the peer's own code at 0.69 "not yours", which the
 * plain question kept at 0.58 and so noted.
 */
export function concernQuestionFor(
	receiver: Pick<Receiver, "changing">,
): typeof concernQuestion {
	return (receiver.changing ?? []).length > 0
		? concernQuestionNow
		: concernQuestion;
}

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
			...((receiver.changing ?? []).length > 0
				? { changing_now: [...(receiver.changing ?? [])] }
				: {}),
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
