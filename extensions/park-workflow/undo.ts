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

/** What a park had said by the time it failed, to be taken back. */
export interface HalfPark {
	readonly session: string;
	/** Its park folder, or the usual one where undefined. */
	readonly folder: string | undefined;
	/** The wake it wrote ahead of a park its run goes on from. */
	readonly wakeWritten?: string;
	/** Told its holder it parked (sayParked), as ending its process does. */
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
	/** Why each part it couldn't take back stands. */
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
	const tryTo = (step: () => void): void => {
		try {
			step();
		} catch (error) {
			left.push(messageOf(error));
		}
	};
	// Its next park would be woken at once by a wake left behind.
	if (half.wakeWritten !== undefined) {
		const wake = half.wakeWritten;
		tryTo(() => rmSync(wake, { force: true }));
	}
	tryTo(() => clearParked(half.session, half.folder));
	if (half.saidToHolder) tryTo(() => unsayParked(half.env, half.pid));
	const undone: ParkUndone = { session: half.session };
	tryTo(() => half.bus.emit(PARK_UNDONE, undone));
	if (left.length > 0) throw new ParkLeftHalfDone(failed, left);
	throw failed;
}
