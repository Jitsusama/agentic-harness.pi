/**
 * Each hosted conversation's log, held open read-only for as long as the
 * host holds the conversation, running or parked, so what reads the
 * machine can tell a host that holds a conversation from one that only
 * once said it did: mycelium believes a claim to own a session only
 * where its owner holds that log open, and a host that died or
 * restarted holds none. A conversation that becomes another (a /new, a
 * fork, a rollover) holds the log it became, and the one it was lets
 * its log go as it ends.
 */
import { closeSync, openSync } from "node:fs";

/** The logs a host holds open, one a conversation. */
export interface HeldLogs {
	/** Hold a conversation's log open, once; a log other than the one held replaces it. */
	hold(sessionId: string, file: string): void;
	/** Let a conversation's log go; nothing when none is held. */
	release(sessionId: string): void;
}

/** Hold conversations' logs open, saying through `report` what fails. */
export function heldLogs(report: (error: unknown) => void): HeldLogs {
	const held = new Map<
		string,
		{ readonly file: string; readonly fd: number }
	>();

	function release(sessionId: string): void {
		const log = held.get(sessionId);
		if (!log) return;
		held.delete(sessionId);
		try {
			closeSync(log.fd);
		} catch (error) {
			report(error);
		}
	}

	return {
		hold(sessionId, file) {
			if (held.get(sessionId)?.file === file) return;
			release(sessionId);
			try {
				held.set(sessionId, { file, fd: openSync(file, "r") });
			} catch (error) {
				// The conversation runs on; only its host's claim to it goes unbelieved.
				report(error);
			}
		},
		release,
	};
}
