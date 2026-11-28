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

/** What the engine holds of a conversation that begins to park. */
export interface ParkingConversation {
	/** pi's runtime, whose session manager writes its log, once it has one. */
	readonly runtime?: {
		readonly session: { readonly sessionManager: RollingConversation["log"] };
	};
	/** Its bus, which says the bash calls its park carried. */
	readonly bus: RollingConversation["bus"];
	/** Whether it parks now, read at each carry heard. */
	readonly parking?: boolean;
}

/**
 * Say in a parking conversation's log that it rolls, as sayRolled does,
 * from what the engine holds of it: nothing where it has no session yet.
 * Answers what stops hearing its park's carry. A log that can't be
 * written is reported, and the park goes on all the same.
 */
export function sayRolledIn(
	host: RollingHost,
	sessionId: string,
	conversation: ParkingConversation,
	report: (error: unknown) => void,
): () => void {
	const log = conversation.runtime?.session.sessionManager;
	if (log === undefined) return () => undefined;
	try {
		return sayRolled(host, sessionId, {
			log,
			bus: conversation.bus,
			parking: () => conversation.parking === true,
			report,
		});
	} catch (error) {
		report(error);
		return () => undefined;
	}
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
