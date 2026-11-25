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
	/** The wake it wrote ahead of a park its run goes on from. */
	readonly wakeWritten?: string;
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
 * A park that failed part-way and couldn't be wholly taken back: what it
 * left may still read as parked until the session is restarted.
 */
export class ParkLeftHalfDone extends Error {
	/** Each part it couldn't take back, and why it stands. */
	readonly left: readonly string[];

	constructor(failed: unknown, left: readonly string[]) {
		super(messageOf(failed));
		this.name = "ParkLeftHalfDone";
		this.left = left;
	}
}

/**
 * Takes back what `half` says the park had said, then throws `failed`
 * again as it was, or a {@link ParkLeftHalfDone} where any part of
 * the taking back failed too. Every part is tried, whichever fails.
 * Windows it moved off the screen stay where they went.
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
	// Its marker first, so no sender finds it parked and writes a wake
	// once its own is gone.
	tryTo("its parked marker", () => clearParked(half.session, half.folder));
	// Its next park would be woken at once by a wake left behind.
	if (half.wakeWritten !== undefined) {
		const wake = half.wakeWritten;
		tryTo("its wake", () => rmSync(wake, { force: true }));
	}
	if (half.saidToHolder) {
		tryTo("its word to its holder", () => unsayParked(half.env, half.pid));
		takeBackExit();
	}
	// pi's bus says a listener's failure itself rather than throwing, so
	// a mesh left reading it as parked shows there, never in `left`.
	const undone: ParkUndone = { session: half.session };
	half.bus.emit(PARK_UNDONE, undone);
	if (left.length > 0) throw new ParkLeftHalfDone(failed, left);
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
	return `its last park failed, so it tries again half an hour on: ${messageOf(failed.error)}`;
}
