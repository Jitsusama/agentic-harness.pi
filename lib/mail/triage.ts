/**
 * What a piece of mail should do to the session it reaches.
 *
 * Mail is only worth its place in a conversation when it bears on
 * what that session does. Most of what goes to everyone is one
 * session's progress on its own work ("merging core.nix#330", "my VM
 * test is done"), and handed to every other session it spends their
 * context on what they will never act on. The opposite failure is a
 * question sent to a session that is idle: it sits unread until the
 * person next speaks, and its sender waits on it ("sorry, I only just
 * saw your mail", twenty-two minutes later).
 *
 * So each mail gets one of three answers. Into the conversation, for
 * what is addressed to this session, what concerns its work and what
 * touches the whole machine. On screen only, for another session's
 * own business, where the person still sees it and `mail_read` still
 * finds it, but the model does not carry it. And a turn, for a
 * question this session is the one to answer when it is idle, since
 * nothing else would ever get it read.
 *
 * Whether mail concerns a session is a judgement, which a classifier
 * makes well when there is one (see {@link concernQuestion}). Without
 * one the answer falls back to what the words show: mail that names
 * this session or something it owns concerns it, and anything else
 * goes into the conversation as it always has, because delivering
 * mail that did not matter costs a little context and dropping mail
 * that did costs the work it was about.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import { kindOf, type Mail } from "./mailbox.ts";

/** Whose business a mail is, from where its receiver stands. */
export type Concern = "receiver" | "machine" | "other";

/** What a receiving session works on, for judging what concerns it. */
export interface Receiver {
	/** The name it signs with. */
	readonly name: string;
	/** Its work in a phrase: the quest's title, or where it runs. */
	readonly worksOn: string;
	/** What it owns by name: repositories, its quest, its channels. */
	readonly owns: readonly string[];
}

/** What a mail does to the session it reaches. */
export interface Verdict {
	/** The conversation, or the screen alone. */
	readonly into: "context" | "screen";
	/** Start a turn for it, which only an idle session is given. */
	readonly wake: boolean;
	/** Why, in a phrase, for the screen and the tests. */
	readonly why: string;
}

/** Where the session stands when the mail arrives. */
export interface Standing {
	/** Every name the session answers to. */
	readonly names: readonly string[];
	readonly receiver: Receiver;
	/** Nothing is running, so mail would otherwise wait for the person. */
	readonly idle: boolean;
	/** The classifier's judgement, when one could be had. */
	readonly concern?: Concern;
}

/**
 * Below this, a classifier's "not yours" is not trusted enough to keep
 * mail out of the conversation. Delivering mail that turns out not to
 * matter costs a few lines; keeping out mail that did costs the work.
 */
export const OTHER_AT_LEAST = 0.6;

/** What one mail does to a session standing like this. */
export function triage(mail: Mail, at: Standing): Verdict {
	const kind = kindOf(mail);
	if (mail.to.some((to) => at.names.includes(to))) {
		return {
			into: "context",
			wake: at.idle && kind === "question",
			why: "addressed to this session",
		};
	}
	const concern = at.concern ?? (mentions(mail, at) ? "receiver" : undefined);
	// A hold is kept whatever it is judged, since what it holds is
	// usually heavy work any session may be about to start, and a hold
	// missed is the one mistake here that costs someone else.
	if (concern === "other" && kind !== "hold") {
		return {
			into: "screen",
			wake: false,
			why: "about another session's work",
		};
	}
	return {
		into: "context",
		wake: at.idle && kind === "question" && concern === "receiver",
		why:
			concern === "receiver"
				? "about this session's work"
				: concern === "machine"
					? "about the whole machine"
					: "not judged, so delivered",
	};
}

/**
 * Whether the mail names this session or something it owns, which is
 * what can be told without a classifier. Names are matched as words
 * and owned things as written, ignoring case, and anything shorter
 * than four letters is too common a word to count.
 */
export function mentions(
	mail: Mail,
	at: Pick<Standing, "names" | "receiver">,
): boolean {
	const text = mail.text.toLowerCase();
	const names = at.names.some((name) =>
		new RegExp(`\\b${escapeRegExp(name.toLowerCase())}\\b`).test(text),
	);
	return (
		names ||
		at.receiver.owns.some(
			(owned) => owned.length >= 4 && text.includes(owned.toLowerCase()),
		)
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The question a classifier is asked, one call per mail and receiver.
 *
 * Asked as whose business the mail is, with the three answers
 * concrete, because "does this concern the receiver" put to Jev came
 * back near even for all four mails it was tried on, and this framing
 * sorted six of six the way a person would.
 */
export const concernQuestion = {
	about: {
		type: "choice" as const,
		instructions:
			"Whose work is this mail about, compared with what the receiving session works on and owns?",
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

/** What the classifier is shown: the receiver, and the mail. */
export function concernState(
	mail: Mail,
	receiver: Receiver,
): ClassifierContext["state"] {
	return {
		receiver: {
			name: receiver.name,
			works_on: receiver.worksOn,
			owns: [...receiver.owns],
		},
		mail: {
			from: mail.from,
			to: mail.to.join(", "),
			kind: kindOf(mail),
			text: mail.text,
		},
	};
}

/**
 * The classifier's answer as a concern, or nothing when it gave none
 * worth acting on: a failed call, an unknown label, or a "not yours"
 * too unsure to keep mail out on.
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
