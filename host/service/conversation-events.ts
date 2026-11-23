/**
 * The roster kept true to what pi did inside a conversation the host
 * runs: the one it became held in its place, and one that ended
 * dropped, with the journal's line for each end.
 */
import { sessionAddress } from "../../lib/mesh/address.ts";
import type { ConversationEvents } from "./backend.ts";
import type { HostRoster } from "./roster.ts";

/**
 * One conversation's end as the journal says it: its mesh address, its
 * id, and why, the caller or viewer that asked among it.
 */
export function endedLine(sessionId: string, why: string): string {
	return `${sessionAddress(sessionId)} (${sessionId}) ended: ${why}`;
}

/**
 * Keep the roster true to what pi did inside a conversation. A conversation
 * that becomes another is held in its place in one write, keeping whether
 * it is attended, its quest and, unless the engine derived a new one, its
 * launch environment; one that ended is dropped. A drop that fails is
 * reported rather than thrown back into pi, whose conversation has already
 * ended; a replacement that fails rejects, so the engine never runs a
 * conversation nothing holds.
 */
export function conversationEvents(options: {
	roster: HostRoster;
	report: (error: unknown) => void;
	/** How a parked conversation is woken: the backend's wake, once it exists. */
	wake?: (sessionId: string) => Promise<void>;
	now?: () => Date;
	/** Writes a line to the host's journal: one for each conversation that ends, and why. */
	say?: (line: string) => void;
}): ConversationEvents {
	const { roster, report } = options;
	const now = options.now ?? (() => new Date());
	const { wake } = options;
	return {
		...(wake ? { wake } : {}),
		async ended(sessionId, why) {
			options.say?.(endedLine(sessionId, why));
			try {
				await roster.drop(sessionId);
			} catch (error) {
				report(error);
			}
		},
		async became(previousId, next) {
			const previous = roster
				.entries()
				.find((held) => held.sessionId === previousId);
			if (!previous) throw new Error(`Conversation is not held: ${previousId}`);
			const launch = next.launch ?? previous.launch;
			await roster.replace(previousId, {
				sessionId: next.sessionId,
				file: next.file,
				cwd: next.cwd,
				attended: previous.attended,
				...(previous.quest ? { quest: previous.quest } : {}),
				since: now().toISOString(),
				...(launch ? { launch } : {}),
			});
		},
	};
}
