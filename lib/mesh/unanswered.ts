/**
 * Every question on the mesh still waiting on a peer it named.
 *
 * On 2026-10-25 Joel noticed sessions sitting on questions before the
 * orchestrator did, since nothing showed what was open across the mesh:
 * each asker saw only its own. This lists them all, from any peer, so a
 * stuck session shows up as an old line here. A question counts as put
 * to each address it went to (`@` groups), and as answered for one once
 * a message from that peer, under any of its addresses, answers it or
 * anything in its thread: the orchestrator's first use of this view
 * listed 21 questions, most settled by an answer to a follow-up. One
 * the asker withdrew (`supersedes`) or moved on from, by asking again in
 * answer to it, is closed.
 */

import type { Message } from "./message.ts";

/** How far back a question is still listed as open. */
export const UNANSWERED_WITHIN_MS = 2 * 60 * 60 * 1000;

/** How far up a thread an answer is followed, a guard against loops. */
const MOST_THREAD_DEPTH = 20;

/** A question, and the addresses it went to that have not answered. */
export interface Open {
	readonly message: Message;
	readonly waitingOn: readonly string[];
}

/**
 * The open questions among these messages, oldest first. `aliases` gives
 * every address a peer goes by, from any one of them.
 */
export function unanswered(
	messages: readonly Message[],
	aliases: (address: string) => readonly string[],
	now: number = Date.now(),
): Open[] {
	const recent = messages.filter(
		(message) => now - Date.parse(message.at) <= UNANSWERED_WITHIN_MS,
	);
	const byId = new Map(messages.map((message) => [message.id, message]));
	const sameAs = (one: string, other: string) =>
		one === other || aliases(one).includes(other);
	const withdrawn = new Set(
		recent.flatMap((message) =>
			message.supersedes ? [message.supersedes] : [],
		),
	);
	const answeredBy = new Map<string, Set<string>>();
	for (const message of recent) {
		let re = message.re;
		for (
			let depth = 0;
			re !== undefined && depth < MOST_THREAD_DEPTH;
			depth++
		) {
			const above = byId.get(re);
			if (
				depth === 0 &&
				above &&
				message.intent === "question" &&
				sameAs(message.from, above.from)
			) {
				withdrawn.add(re);
			}
			const by = answeredBy.get(re) ?? new Set<string>();
			for (const address of aliases(message.from)) by.add(address);
			by.add(message.from);
			answeredBy.set(re, by);
			re = above?.re;
		}
	}
	const open: Open[] = [];
	for (const message of recent) {
		if (message.intent !== "question" || withdrawn.has(message.id)) continue;
		const by = answeredBy.get(message.id) ?? new Set<string>();
		const waitingOn = message.to
			.filter((group) => group.startsWith("@"))
			.map((group) => group.slice(1))
			.filter((address) => address !== message.from && !by.has(address));
		if (waitingOn.length > 0) open.push({ message, waitingOn });
	}
	return open.sort(
		(a, b) => Date.parse(a.message.at) - Date.parse(b.message.at),
	);
}
