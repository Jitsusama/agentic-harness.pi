/**
 * A message on the mesh, and its envelope.
 *
 * A peer signs what it sends with its address and says what it asks of
 * its readers as an intent; the mesh stamps when it was sent and gives
 * it an id, so no sender's clock or naming decides the order. The
 * envelope is read leniently, because peers on different versions of
 * the harness share one mesh: a field a reader does not know is
 * ignored, and an intent it does not know reads as an fyi, so an older
 * peer never breaks on a newer message.
 */

import { hosted } from "../core/session/host.ts";
import { ALL, hears, homeOf } from "./group.ts";

/**
 * What a message asks of the peers it reaches.
 *
 * - hold: put off what it names until its sender says the hold is over.
 * - question: wants an answer.
 * - finding: something learned about what another peer owns.
 * - fyi: context only.
 * - pivot: change what you are doing. Only an orchestrator sends one, to
 *   the sessions it orchestrates, and each answers once it has changed
 *   course.
 */
export const INTENTS = ["hold", "question", "finding", "fyi", "pivot"] as const;

export type Intent = (typeof INTENTS)[number];

/** The envelope version this harness writes. */
export const ENVELOPE = 1;

/** One message, as the mesh carries it. */
export interface Message {
	readonly v: number;
	/** Unique, and sorting in the order messages were sent. */
	readonly id: string;
	/** When it was sent, as an ISO time, stamped by the mesh. */
	readonly at: string;
	/** The address of the peer that sent it. */
	readonly from: string;
	/** The canonical groups it went to (see group.ts). */
	readonly to: readonly string[];
	readonly intent: Intent;
	readonly text: string;
	/** The sending process; hosted conversations share it. */
	readonly pid: number;
	/** The sender is a conversation in a shared host, not the whole pid. */
	readonly hosted?: true;
	/**
	 * A named group the sender brings the peers it is sent to into, which
	 * each joins on receipt and may leave. Older readers ignore it and
	 * read the text, which says the same.
	 */
	readonly invite?: string;
	/** The id of the message this one answers (see thread.ts). */
	readonly re?: string;
	/**
	 * The id of a message its sender sent earlier that this one replaces,
	 * reaching everyone who heard that one (see thread.ts).
	 */
	readonly supersedes?: string;
	/**
	 * That the hold it answers (`re`) is over on the person's word, said
	 * by a peer other than its holder once the person confirmed it. Only
	 * a holder ends its hold otherwise (see thread.ts).
	 */
	readonly endsHold?: true;
	/**
	 * The realm it crossed from, written by the node that carried it in
	 * (see flow.ts). Nothing said here reaches back there, so nobody here
	 * can answer it.
	 */
	readonly fromRealm?: string;
}

/** What a sender says; the mesh adds the rest. */
export type Draft = Pick<
	Message,
	| "from"
	| "to"
	| "intent"
	| "text"
	| "pid"
	| "hosted"
	| "invite"
	| "re"
	| "supersedes"
	| "endsHold"
>;

/** The process sending, with a stamp when it shares ownership with siblings. */
export function senderIdentity(): Pick<Message, "pid" | "hosted"> {
	const host = hosted();
	return host ? { pid: host.owner.pid, hosted: true } : { pid: process.pid };
}

/** Who a message could be for: a peer's addresses and groups. */
export interface Listener {
	/** A shared host owns several listeners in the same process. */
	readonly hosted?:
		| boolean
		| { readonly host: string; readonly conversation: string };
	readonly addresses: readonly string[];
	/** The groups it joined, beside its home groups and the machine's. */
	readonly groups: readonly string[];
	/**
	 * The machine it runs on, when that is another one (see presence.ts);
	 * absent, it runs on this machine.
	 */
	readonly machine?: string;
}

/**
 * A message read from outside, or nothing when it is not one. The one
 * place an envelope is checked; past here it is trusted.
 *
 * One waiting to cross into another realm (`forRealm`) is none of this
 * realm's: a machine that doesn't cross keeps it only until a link
 * carries it to one that does, and nobody here is to read it.
 */
export function messageFrom(value: unknown): Message | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const one = value as Record<string, unknown>;
	if (one.forRealm !== undefined) return undefined;
	const valid =
		typeof one.id === "string" &&
		typeof one.at === "string" &&
		typeof one.from === "string" &&
		Array.isArray(one.to) &&
		one.to.every((to) => typeof to === "string") &&
		typeof one.text === "string" &&
		typeof one.pid === "number";
	if (!valid) return undefined;
	return {
		v: typeof one.v === "number" ? one.v : ENVELOPE,
		id: one.id as string,
		at: one.at as string,
		from: one.from as string,
		to: one.to as string[],
		intent: intentOf(one.intent),
		text: one.text as string,
		pid: one.pid as number,
		...(one.hosted === true ? { hosted: true as const } : {}),
		...(typeof one.invite === "string" ? { invite: one.invite } : {}),
		...(typeof one.re === "string" ? { re: one.re } : {}),
		...(typeof one.supersedes === "string"
			? { supersedes: one.supersedes }
			: {}),
		...(one.endsHold === true && typeof one.re === "string"
			? { endsHold: true as const }
			: {}),
		...(typeof one.fromRealm === "string" && one.fromRealm !== ""
			? { fromRealm: one.fromRealm }
			: {}),
	};
}

/**
 * The short form of a message's id, its last part, which a peer may
 * write instead of the whole id when it answers or replaces one.
 */
export function shortId(message: Pick<Message, "id">): string {
	return message.id.slice(message.id.lastIndexOf("-") + 1);
}

/** An intent as written, or an fyi when it is none this version knows. */
function intentOf(written: unknown): Intent {
	return (INTENTS as readonly unknown[]).includes(written)
		? (written as Intent)
		: "fyi";
}

/**
 * Whether a message reaches this listener: sent to a group it hears,
 * and never its own. Plain peers also compare the process, since a pi
 * that loaded another quest still sent what it sent; hosted peers use
 * addresses alone because siblings share a process. The machine's group is
 * this machine's alone: a session elsewhere, whose presence another
 * machine's node carries here, never hears it, so a hold before this
 * machine restarts neither parks it nor waits on its answer.
 */
export function reaches(
	message: Message,
	listener: Listener,
	pid: number,
): boolean {
	const groups = [...listener.groups, ...listener.addresses.map(homeOf)];
	const elsewhere = listener.machine !== undefined;
	return (
		(listener.hosted || message.hosted || message.pid !== pid) &&
		!listener.addresses.includes(message.from) &&
		message.to.some(
			(group) => !(elsewhere && group === ALL) && hears(groups, group),
		)
	);
}

/** Whether a message went to the home group of one of these addresses. */
export function isHomeTo(
	message: Message,
	addresses: readonly string[],
): boolean {
	return addresses.some((address) => message.to.includes(homeOf(address)));
}

/**
 * Whether a message is a question asked of this peer as one of each it
 * went to, so another's answer is not this peer's: sent to its home, or
 * to a named group it is a member of. A question to the machine's group
 * asks nobody in particular, and a peer following another's home group
 * hears that peer's questions without being asked them.
 */
export function asksEach(message: Message, listener: Listener): boolean {
	if (message.intent !== "question" || message.to.includes(ALL)) return false;
	return (
		isHomeTo(message, listener.addresses) ||
		message.to.some(
			(group) => group.startsWith("#") && hears(listener.groups, group),
		)
	);
}

/**
 * When a message was sent, as HH:MM in local time, with the date before
 * it when that was not today, so what a peer catches up on after a night
 * is not read as this morning's.
 */
export function clock(
	message: Pick<Message, "at">,
	now: Date = new Date(),
): string {
	const at = new Date(message.at);
	const time = at.toTimeString().slice(0, 5);
	if (at.toDateString() === now.toDateString()) return time;
	const two = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${time}`;
}

/** A message on one line, for listings and glances. */
export function line(message: Message): string {
	return `${heading(message)}: ${message.text}`;
}

/**
 * A message's when, id, intent, sender and groups, without its text: what
 * a sender is told of what it sent, since the text is already before it.
 */
export function heading(message: Message): string {
	return `${clock(message)} [${shortId(message)}] ${message.intent} from ${sender(message)} to ${message.to.join(", ")}`;
}

/** Who sent a message, with the realm it crossed from when it did. */
export function sender(message: Pick<Message, "from" | "fromRealm">): string {
	return message.fromRealm
		? `${message.from} in the ${message.fromRealm} realm`
		: message.from;
}
