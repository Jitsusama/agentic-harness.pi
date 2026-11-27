/**
 * Saying in a conversation's log that it parks to roll onto new host
 * code, so the next pi to start on that log can tell the session of its
 * roll (lib/internal/reload/rolled.ts reads it). One entry goes as the
 * park begins; a second, saying the host wakes it, follows once the park
 * carries bash calls, since their end wakes it with nobody sending it
 * anything. A park that is refused leaves its entry, which the reader
 * voids once the conversation answers again.
 */

import {
	HOST_ROLLED_ENTRY,
	type HostRolled,
	type RolledCode,
} from "../../lib/core/session/host.ts";
import { hearParkCarry } from "./parked-calls.ts";

/** What saying a conversation's roll reads of its host. */
export interface RollingHost {
	/** Whether this conversation parks to roll, its host's code stale and no window viewing it. */
	rolling(sessionId: string): boolean;
	/** The code the host rolls from and onto, or nothing where its roll named none. */
	rolledCode(): RolledCode | undefined;
}

/** The parts of a conversation saying its roll writes to and hears. */
export interface RollingConversation {
	/** Its log, where the entry goes. */
	readonly log: {
		appendCustomEntry(customType: string, data?: unknown): unknown;
	};
	/** Its bus, which says the bash calls its park carried. */
	readonly bus: {
		on(channel: string, listener: (data: unknown) => void): () => void;
	};
	/** Whether it parks now, so a carry heard is its park's. */
	readonly parking: () => boolean;
	/** Told what writing the second entry threw, as its park goes on. */
	readonly report: (error: unknown) => void;
}

/**
 * As `sessionId` begins to park, say in its log that it rolls, where its
 * host rolls it and names the code, and again, once, that the host wakes
 * it, as its park carries bash calls. Answers what stops hearing the
 * carry, called as the park settles; nothing is written or heard where
 * it doesn't roll, or the code is unnamed.
 */
export function sayRolled(
	host: RollingHost,
	sessionId: string,
	conversation: RollingConversation,
	now: () => Date = () => new Date(),
): () => void {
	const code = host.rolledCode();
	if (code === undefined || !host.rolling(sessionId)) return () => undefined;
	const rolled: HostRolled = {
		from: code.from,
		onto: code.onto,
		at: now().toISOString(),
	};
	conversation.log.appendCustomEntry(HOST_ROLLED_ENTRY, rolled);
	let woken = false;
	return hearParkCarry(conversation.bus, conversation.parking, () => {
		if (woken) return;
		woken = true;
		const wakes: HostRolled = { ...rolled, wakes: true };
		try {
			conversation.log.appendCustomEntry(HOST_ROLLED_ENTRY, wakes);
		} catch (error) {
			conversation.report(error);
		}
	});
}
