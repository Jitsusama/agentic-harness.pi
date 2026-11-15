/**
 * A send-back held back for a move: while a move waits for the session
 * to be free, away mode writes the run it would have sent back to work
 * into the session's log instead of starting it, so the session is free
 * at the move's next look; whichever pi opens the log next sends it on.
 *
 * Sent at once, each send-back started the next run the moment the last
 * settled, and a move looks only between runs, so a session away mode
 * kept going was never free: on 15 November a release waited out its
 * whole deadline on one (E28, tests/host/end-to-end/release-queued).
 */

import { join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { readMoveNote } from "../../lib/internal/session/move.ts";
import { createPresences } from "../../lib/mesh/presence.ts";

/** The log entry a send-back held back for a move leaves. */
export const HELD_BACK_ENTRY = "away-held-back";

/**
 * How often a session that held a send-back back looks whether its move
 * was called off, as the move itself looks (mesh-workflow moving.ts).
 */
export const HELD_LOOK_MS = 2_000;

/** What a held-back send-back keeps: the words it would have sent. */
export interface HeldBack {
	readonly text: string;
}

function isHeldBack(value: unknown): value is HeldBack {
	return isRecord(value) && typeof value.text === "string";
}

/** Whether a move waits for `session`, as its presence says. */
export function moveWaits(
	session: string,
	moving: (session: string) => unknown = (one) =>
		createPresences(join(stateDir("mesh-workflow"), "presence")).of(one)
			?.moving,
): boolean {
	return moving(session) !== undefined;
}

/**
 * Whether `session` has ended to move: its note is written, so the pi
 * that opens it next sends the held send-back on, not this one.
 */
export function movedOn(
	session: string,
	note: (session: string) => unknown = (one) => readMoveNote(one),
): boolean {
	return note(session) !== undefined;
}

function field(entry: unknown, name: string): unknown {
	return isRecord(entry) ? entry[name] : undefined;
}

/**
 * The words of a send-back held back at the end of `branch` and not yet
 * sent, or nothing: anything said in the conversation after it, a
 * message or a delivered note, means it was sent or overtaken.
 */
export function heldBackIn(branch: readonly unknown[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		const type = field(entry, "type");
		if (type === "message" || type === "custom_message") return undefined;
		if (type === "custom" && field(entry, "customType") === HELD_BACK_ENTRY) {
			const data = field(entry, "data");
			return isHeldBack(data) ? data.text : undefined;
		}
	}
	return undefined;
}
