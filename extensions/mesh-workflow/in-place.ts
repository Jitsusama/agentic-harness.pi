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

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	AGAIN_ENV,
	flagsLost,
	heldDirectly,
	PARKED_EXIT,
	restartCommand,
	WAKE_ENV,
} from "../../lib/internal/session/park.ts";

/** The join a window's pi hands it to, beside this package's scripts. */
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
	const wake = facts.env[WAKE_ENV] ?? "";
	const again = facts.env[AGAIN_ENV] ?? "";
	if (wake === "" || again === "") return undefined;
	if (!heldDirectly(wake, facts.pid)) return undefined;
	if (facts.sessionFile === undefined) return undefined;
	if (flagsLost(facts.args).length > 0) return undefined;
	const command = joinCommand(
		facts.session,
		restartCommand(facts.sessionFile, facts.args),
	);
	return {
		end: () => {
			writeFileSync(again, JSON.stringify(command));
			writeFileSync(
				wake,
				JSON.stringify({
					session: facts.session,
					move: true,
					at: new Date().toISOString(),
				}),
			);
			goQuiet();
		},
	};
}

/**
 * The words that start the join for `session`: `--session` and its id
 * first, which is how mycelium's node knows the window the join holds
 * is the hosted session's, then plain pi's words should it fall back.
 */
export function joinCommand(
	session: string,
	plainPi: readonly string[],
): string[] {
	return [
		process.execPath,
		JOIN_SCRIPT,
		"--session",
		session,
		"--",
		...plainPi,
	];
}

/** Writes nothing, so pi's last frame stays on the terminal. */
function nothingWritten(): boolean {
	return true;
}

/**
 * From here on this process reads no keys, leaves the terminal as it is
 * and writes nothing to it, and ends with PARKED_EXIT whatever pi ends
 * with, so its holder starts what it named at once.
 */
function goQuiet(): void {
	// Paused outright, so even pi's drain at exit reads none of the keys.
	process.stdin.pause();
	// Left raw: cooked, the terminal would echo what Joel types over the
	// frame until the join's attach takes it raw again.
	if (process.stdin.isTTY) process.stdin.setRawMode = () => process.stdin;
	process.stdout.write = nothingWritten;
	process.stderr.write = nothingWritten;
	// pi ends a quit with process.exit(0); an exit listener's code wins.
	process.once("exit", () => {
		process.exitCode = PARKED_EXIT;
	});
}
