/**
 * Threads: how messages answer and replace one another.
 *
 * A message may say it answers another (`re`), which is how a peer
 * knows an answer to its own question is for it wherever it was sent,
 * and how far a conversation has run, since two peers answering each
 * other's answers is the loop that wears both out. A message may also
 * replace one its sender sent earlier (`supersedes`), which is how a
 * withdrawal reaches everyone who heard what it withdraws: River
 * repeated withdrawn advice 55 and 92 minutes after the fix, because
 * the fix reached only those who went looking for it.
 */

import type { Message } from "./message.ts";

/** Reads a message by id, as a transport does. */
export type Reader = (id: string) => Message | undefined;

/** Who a peer is when asking whether a message answers it. */
export interface Self {
	readonly addresses: readonly string[];
	readonly pid: number;
}

/**
 * How far past this the reply depth is never counted; a thread that
 * deep is already deeper than any limit on it.
 */
const DEEPEST_COUNTED = 16;

/**
 * How many answers deep a message is: none for one that answers
 * nothing, one for an answer, two for an answer to that. An answer to
 * a message that cannot be read counts the one step it can see.
 */
export function depthOf(message: Message, read: Reader): number {
	let depth = 0;
	const seen = new Set([message.id]);
	let next = message.re;
	while (next !== undefined && depth < DEEPEST_COUNTED) {
		depth += 1;
		if (seen.has(next)) break;
		seen.add(next);
		next = read(next)?.re;
	}
	return depth;
}

/** Whether this message answers one this peer sent. */
export function answers(message: Message, read: Reader, self: Self): boolean {
	if (message.re === undefined) return false;
	const answered = read(message.re);
	return answered !== undefined && sentBy(answered, self);
}

/**
 * Whether this message answers a question this peer asked, which the
 * peer is waiting on whatever intent the answer was sent with.
 */
export function answersQuestion(
	message: Message,
	read: Reader,
	self: Self,
): boolean {
	if (message.re === undefined) return false;
	const asked = read(message.re);
	return asked?.intent === "question" && sentBy(asked, self);
}

/** Whether this peer sent the message, by address or by process. */
export function sentBy(message: Message, self: Self): boolean {
	return message.pid === self.pid || self.addresses.includes(message.from);
}

/**
 * Whether a message may supersede this one: only its own sender may
 * replace what it said.
 */
export function mayReplace(replacement: Message, original: Message): boolean {
	return (
		replacement.id > original.id &&
		(replacement.from === original.from || replacement.pid === original.pid)
	);
}

/**
 * The message an id names, written whole or as its last part (the
 * eight characters after its final dash), when exactly one matches.
 */
export function idNamed(
	written: string,
	ids: readonly string[],
): string | undefined {
	const one = written.trim();
	if (one === "") return undefined;
	if (ids.includes(one)) return one;
	const matching = ids.filter((id) => id.endsWith(`-${one}`));
	return matching.length === 1 ? matching[0] : undefined;
}
