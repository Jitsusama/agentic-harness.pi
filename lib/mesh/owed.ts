/**
 * Questions still waiting on an answer, seen from both ends.
 *
 * A question put to a peer used to be handed over once. If that turn
 * went on something else, or the model read it and carried on, nothing
 * asked again, and its asker waited without knowing why. On 2026-10-25
 * the orchestrator found sessions sitting on questions put to them for
 * many minutes. So each end keeps its own account:
 *
 * - The peer asked owes an answer until it sends one (`re` set to the
 *   question). Unpaid {@link ASK_AGAIN_MS} after it was last handed
 *   over, it is handed again, at most {@link MOST_ASKED_AGAIN} times
 *   and only within {@link OWED_FOR_MS} of being asked.
 * - The asker awaits an answer from each address it put the question
 *   to by name. Unanswered by one of them {@link ASK_AGAIN_MS} after
 *   it was sent, it is told once that the question is stuck, and with
 *   whom.
 *
 * Both are kept in memory: a reload starts the account again, which
 * at worst asks once more or says once more.
 */

import { homeOf } from "./group.ts";
import type { Message } from "./message.ts";

/** How long a question may go unanswered before it is asked again. */
export const ASK_AGAIN_MS = 5 * 60 * 1000;

/** The most times a question is handed again after the first. */
export const MOST_ASKED_AGAIN = 2;

/** How long after it was asked a question is still owed. */
export const OWED_FOR_MS = 60 * 60 * 1000;

/** The answers this peer owes. */
export interface Owing {
	/** A question put to this peer was handed over now. */
	owe(message: Message, now?: number): void;
	/**
	 * This peer answered the question with this id. A question
	 * answered stays answered: handing it over again, as a turn that
	 * carries what waited does, owes nothing.
	 */
	paid(id: string, now?: number): void;
	/**
	 * The questions to hand again now, with how many times each has
	 * been handed before; each is counted as handed again.
	 */
	due(now?: number): readonly Again[];
}

/** A question handed again, and the times it was handed before. */
export interface Again {
	readonly message: Message;
	readonly handed: number;
}

/** The answers owed to this peer. */
export interface Awaiting {
	/** This peer sent a question; `self` are its own addresses. */
	asked(message: Message, self: readonly string[], now?: number): void;
	/** An answer came, from a peer going by these addresses. */
	answered(re: string, from: readonly string[]): void;
	/** Questions stuck now, each said once, with who has not answered. */
	stuck(now?: number): readonly Stuck[];
}

/** A question this peer asked, and the addresses that have not answered. */
export interface Stuck {
	readonly message: Message;
	readonly waitingOn: readonly string[];
}

/** An empty account of the answers this peer owes. */
export function createOwing(): Owing {
	const owed = new Map<
		string,
		{ message: Message; handed: number; last: number }
	>();
	// When each answered question was answered, kept as long as a
	// question can be owed, so a late hand-over of one is not owed again.
	const answered = new Map<string, number>();
	return {
		owe(message, now = Date.now()) {
			if (answered.has(message.id)) return;
			const one = owed.get(message.id);
			if (one) one.last = now;
			else owed.set(message.id, { message, handed: 1, last: now });
		},
		paid(id, now = Date.now()) {
			owed.delete(id);
			answered.set(id, now);
		},
		due(now = Date.now()) {
			for (const [id, at] of answered) {
				if (now - at > OWED_FOR_MS) answered.delete(id);
			}
			const again: Again[] = [];
			for (const [id, one] of owed) {
				if (now - Date.parse(one.message.at) > OWED_FOR_MS) {
					owed.delete(id);
					continue;
				}
				if (now - one.last < ASK_AGAIN_MS) continue;
				if (one.handed > MOST_ASKED_AGAIN) {
					owed.delete(id);
					continue;
				}
				again.push({ message: one.message, handed: one.handed });
				one.handed += 1;
				one.last = now;
			}
			return again;
		},
	};
}

/** An empty account of the answers owed to this peer. */
export function createAwaiting(): Awaiting {
	const awaited = new Map<
		string,
		{ message: Message; waitingOn: Set<string>; sent: number }
	>();
	return {
		asked(message, self, now = Date.now()) {
			if (message.intent !== "question") return;
			const mine = new Set(self.map(homeOf));
			const named = message.to
				.filter((group) => group.startsWith("@") && !mine.has(group))
				.map((group) => group.slice(1));
			if (named.length === 0) return;
			awaited.set(message.id, {
				message,
				waitingOn: new Set(named),
				sent: now,
			});
		},
		answered(re, from) {
			const one = awaited.get(re);
			if (!one) return;
			for (const address of from) one.waitingOn.delete(address);
			if (one.waitingOn.size === 0) awaited.delete(re);
		},
		stuck(now = Date.now()) {
			const stuck: Stuck[] = [];
			for (const [id, one] of awaited) {
				if (now - one.sent < ASK_AGAIN_MS) continue;
				stuck.push({ message: one.message, waitingOn: [...one.waitingOn] });
				awaited.delete(id);
			}
			return stuck;
		},
	};
}
