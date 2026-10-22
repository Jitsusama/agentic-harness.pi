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

import { hears, homeOf } from "./group.ts";

/**
 * What a message asks of the peers it reaches.
 *
 * - hold: put off what it names until its sender says the hold is over.
 * - question: wants an answer.
 * - finding: something learned about what another peer owns.
 * - fyi: context only.
 */
export const INTENTS = ["hold", "question", "finding", "fyi"] as const;

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
	/** The sending process, so a peer never hands itself its own. */
	readonly pid: number;
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
}

/** What a sender says; the mesh adds the rest. */
export type Draft = Pick<
	Message,
	"from" | "to" | "intent" | "text" | "pid" | "invite" | "re" | "supersedes"
>;

/** Who a message could be for: a peer's addresses and groups. */
export interface Listener {
	readonly addresses: readonly string[];
	/** The groups it joined, beside its home groups and the machine's. */
	readonly groups: readonly string[];
}

/**
 * A message read from outside, or nothing when it is not one. The one
 * place an envelope is checked; past here it is trusted.
 */
export function messageFrom(value: unknown): Message | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const one = value as Record<string, unknown>;
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
		...(typeof one.invite === "string" ? { invite: one.invite } : {}),
		...(typeof one.re === "string" ? { re: one.re } : {}),
		...(typeof one.supersedes === "string"
			? { supersedes: one.supersedes }
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
 * and never its own, by address or by process, since a peer that
 * loaded another quest still sent what it sent.
 */
export function reaches(
	message: Message,
	listener: Listener,
	pid: number,
): boolean {
	const groups = [...listener.groups, ...listener.addresses.map(homeOf)];
	return (
		message.pid !== pid &&
		!listener.addresses.includes(message.from) &&
		message.to.some((group) => hears(groups, group))
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
	return `${clock(message)} [${shortId(message)}] ${message.intent} from ${message.from} to ${message.to.join(", ")}: ${message.text}`;
}
