/**
 * Moving a session into a host in its own window: the pi ends, and the
 * join takes its place in the same terminal, as a rollover restart does
 * (park-workflow), so the window Joel had stays where it was, at its
 * size, with its focus and the last frame pi drew.
 *
 * Before 11 November a move closed the window and the launcher opened a
 * viewer at a kept place: no size kept, the focus left to niri, a
 * blank moment and the transcript flashed as pi left its full screen,
 * and keys typed meanwhile lost (attachments/move-in-place-gaps.md of
 * H2's quest). Now a pi its holder runs itself names the join as what
 * to start next, writes its wake, and exits with PARKED_EXIT; the holder
 * starts the join at once on the same terminal, with no parked line.
 * The join (scripts/host-join.ts) waits for the host to adopt the log,
 * then becomes `mycelium attach`, whose first frame is the host's; or,
 * when the cutover gives up, takes the move back and becomes plain pi.
 *
 * Nothing is drawn in between: from the moment it hands over, this pi
 * writes nothing more to its terminal, so its full screen, its modes and
 * its last frame stay until the host's frame replaces them, and it reads
 * no more keys and leaves the terminal raw, so what Joel types waits in
 * the terminal, unechoed, for whatever reads it next.
 */

import { fileURLToPath } from "node:url";
import {
	goQuiet,
	handingOf,
	toldHolder,
} from "../../lib/internal/session/hand-over.ts";
import {
	JOIN_QUIET,
	viewWords,
} from "../../lib/internal/session/host-holds.ts";
import { holderCommand } from "../../lib/internal/session/park.ts";
import type { Presence } from "../../lib/mesh/presence.ts";

/**
 * The join a window's pi hands it to, beside this package's scripts, in
 * the version this pi loaded: its holder starts it at once, while that
 * version is still on disk, so the hand-over runs one version throughout.
 */
export const JOIN_SCRIPT = fileURLToPath(
	new URL("../../scripts/host-join.ts", import.meta.url),
);

/** What a pi needs to hand its window over. */
export interface InPlaceFacts {
	/** The variables it runs with. */
	readonly env: NodeJS.ProcessEnv;
	/** Its own process. */
	readonly pid: number;
	/** The arguments pi was started with. */
	readonly args: readonly string[];
	/** The session's id, which the join names so its window is known. */
	readonly session: string;
	/** The session's log, which plain pi opens should the join fall back. */
	readonly sessionFile: string | undefined;
	/** Go quiet on the terminal and end as a park; a test says otherwise. */
	readonly quiet?: () => void;
}

/** What the session does to hand its window over, once it may. */
export interface HandOver {
	/** Name the join, ask to be woken into it, and go quiet; then end. */
	readonly end: () => void;
}

/**
 * How this pi would hand its window to the join, or nothing when it
 * can't and a move must close it: a pi no holder runs itself, a holder
 * that takes no next command, no log yet, or flags the join's fallback
 * to plain pi would drop.
 */
export function handOverOf(facts: InPlaceFacts): HandOver | undefined {
	const handing = handingOf(facts);
	if (handing === undefined) return undefined;
	// The holder runs the join in its own environment, so plain pi's words
	// carry the fence and the spawner as a park's restart does.
	const command = joinCommand(
		facts.session,
		holderCommand(handing.sessionFile, facts.args, facts.env),
	);
	return {
		end: () => {
			const told = toldHolder(handing.files, command, {
				session: facts.session,
				move: true,
				at: new Date().toISOString(),
			});
			// The move's own catch says why it stopped; nothing half told stays.
			if (!told) throw new Error("its holder couldn't be told the join");
			(facts.quiet ?? goQuiet)();
		},
	};
}

/**
 * The words that start the join for `session`: node with the flag that
 * keeps its module-type warning out of the window ({@link JOIN_QUIET}),
 * then `--session` and its id, which is how mycelium's node knows the
 * window the join holds is the hosted session's, then plain pi's words
 * should it fall back.
 */
export function joinCommand(
	session: string,
	plainPi: readonly string[],
): string[] {
	return [
		process.execPath,
		JOIN_QUIET,
		JOIN_SCRIPT,
		"--session",
		session,
		"--",
		...plainPi,
	];
}

/**
 * What a hosted conversation's presence says of its host, with the words
 * a window opened on it runs: the join, which becomes its viewer while
 * the host holds it and plain pi on its log once the host lets it go, so
 * a release carries on in the window rather than closing it. It looks
 * once (`--view`), never waiting on a move: a parked conversation is
 * held but not open, and the attach is what wakes it. With no
 * log there are no plain pi words, and mycelium's node gives today's
 * attach words instead. The plain pi words carry the conversation's
 * fence, so a fenced one taken back runs its commands fenced still.
 */
export function hostedPresence(
	host: string,
	session: string,
	sessionFile: string | undefined,
	env: NodeJS.ProcessEnv = {},
): NonNullable<Presence["hosted"]> {
	return {
		host,
		conversation: session,
		...(sessionFile === undefined
			? {}
			: { view: viewWords(session, holderCommand(sessionFile, [], env)) }),
	};
}
