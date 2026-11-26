/**
 * Taking back a park that failed part-way, once it has said it parks
 * and before its process or conversation has ended, so the session
 * reads as awake again rather than parked until it is restarted.
 */

import { rmSync } from "node:fs";
import { messageOf } from "../../lib/internal/carry/message.ts";
import {
	clearParked,
	PARK_UNDONE,
	type ParkUndone,
	unsayParked,
} from "../../lib/internal/session/park.ts";
import { takeBackExit } from "./restart.ts";

/** What a park had said by the time it failed, to be taken back. */
export interface HalfPark {
	readonly session: string;
	/** Its park folder, or the usual one where undefined. */
	readonly folder: string | undefined;
	/**
	 * Its wake file, where a park its run goes on from wrote ahead and a
	 * sender writes once it reads parked; empty where it has none.
	 */
	readonly wake: string;
	/** How many of its windows the park closed, the launcher keeping their place asleep. */
	readonly windowsClosed: number;
	/**
	 * Ended its process, as plain pi parks: told its holder it parked
	 * (sayParked) and said the code it exits with (exitWith).
	 */
	readonly saidToHolder: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly pid: number;
	readonly bus: { emit(channel: string, data: unknown): void };
}

/**
 * A park that failed and couldn't be wholly taken back: a part it left
 * may still read as parked until the session is restarted, and windows
 * it closed stay closed, though they read awake.
 */
export class ParkLeftHalfDone extends Error {
	/** Each part it couldn't take back, which may read as parked, and why. */
	readonly left: readonly string[];
	/** The windows it closed, which can't be opened again from here. */
	readonly closed: string | undefined;

	constructor(failed: unknown, left: readonly string[], closed?: string) {
		super(messageOf(failed));
		this.name = "ParkLeftHalfDone";
		this.left = left;
		this.closed = closed;
	}

	/** Whether any part it left may read as parked. */
	get readsParked(): boolean {
		return this.left.length > 0;
	}
}

/**
 * Takes back what `half` says the park had said, then throws `failed`
 * again as it was, or a {@link ParkLeftHalfDone} where any part of
 * the taking back failed too. Every part is tried, whichever fails.
 *
 * Windows it closed can't be opened again from here, and the launcher
 * still keeps their place asleep, so those are said too, apart from
 * what reads parked, since a session whose windows closed reads awake. An
 * ask to ease the park cleared isn't put back: it would lapse within
 * the half hour the failure holds the clock, and the node asks again
 * while its machine still reads over.
 */
export function undoPark(failed: unknown, half: HalfPark): never {
	const left: string[] = [];
	const tryTo = (part: string, step: () => void): void => {
		try {
			step();
		} catch (error) {
			left.push(`${part} is left: ${messageOf(error)}`);
		}
	};
	// Its marker first, so fewer senders find it parked and write a wake.
	tryTo("its parked marker", () => clearParked(half.session, half.folder));
	if (half.saidToHolder) {
		tryTo("its word to its holder", () => unsayParked(half.env, half.pid));
		takeBackExit();
	}
	// pi's bus says a listener's failure itself rather than throwing, so
	// a mesh left reading it as parked shows there, never in `left`.
	const undone: ParkUndone = { session: half.session };
	half.bus.emit(PARK_UNDONE, undone);
	// Its wake last, whoever wrote it: awake, it needs none, and one left
	// would wake its next park at once. A sender reading its presence
	// before the mesh's write lands may still write one, which costs that
	// next park one start.
	if (half.wake !== "") {
		const wake = half.wake;
		tryTo("its wake", () => rmSync(wake, { force: true }));
	}
	const count = half.windowsClosed === 1 ? "window is" : "windows are";
	const closed =
		half.windowsClosed > 0
			? `its ${count} closed, and the launcher keeps its place asleep`
			: undefined;
	if (left.length > 0 || closed !== undefined) {
		throw new ParkLeftHalfDone(failed, left, closed);
	}
	throw failed;
}

/**
 * How long a park that failed holds the clock's next try: one whose end
 * fails every time would otherwise say it parks, move its windows off
 * the screen and take it all back each minute, and nothing would say so.
 */
export const FAILED_PARK_HOLDS_MS = 30 * 60_000;

/** A park that failed, when, and with what. */
export interface FailedPark {
	readonly at: number;
	readonly error: unknown;
}

/**
 * Why the clock doesn't park again yet, after the park that `failed`;
 * nothing once it is long enough past, or where none failed. The
 * person's Park still tries, since they asked, and so does a host's
 * drain or roll, which waits on the park to restart.
 */
export function heldByFailure(
	failed: FailedPark | undefined,
	now: number,
): string | undefined {
	if (failed === undefined || now - failed.at >= FAILED_PARK_HOLDS_MS) {
		return undefined;
	}
	const why = `its last park failed, so it tries again half an hour on: ${messageOf(failed.error)}`;
	// A take-back that left parts standing says them, as the person's
	// Park would, since the clock parks most and nothing else says so.
	if (failed.error instanceof ParkLeftHalfDone) {
		const { left, closed } = failed.error;
		return [why, ...left, ...(closed === undefined ? [] : [closed])].join("; ");
	}
	return why;
}
