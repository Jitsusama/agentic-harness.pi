/**
 * A child host rolls its conversation onto new code once its install
 * moves on. A child never restarts itself, since its supervisor starts a
 * fresh one for each conversation, so it keeps the host code it loaded
 * for its life: on 22 November 15 children ran host code about 34 hours
 * old and held 10.9 GB. Its conversation's extensions follow the install
 * (reload-workflow), but the host and engine don't. So the child looks
 * now and then at its install, and once the host code there differs it
 * rolls: its conversation parks at its next quiet moment, the parked
 * child with no window exits as it always does, and the next wake starts
 * a fresh child on current code.
 *
 * A child rolls no sooner than an hour after it started. Each roll ends
 * a conversation's process, and it reads as a cut to the cell in it: on
 * 26 November one install move at 15:06 rolled 42 conversations, and
 * cells counted several cuts that day as merges moved the install. Held
 * to an hour, a conversation rolls at most once an hour however often
 * the install moves.
 *
 * Past the hour a child rolls neither at once nor while the machine is
 * busy. On 27 November one install move at 02:53 rolled conversations
 * together, and optimus's CPU `some avg60` went from 20.6 to 64.7 with
 * 18 fresh processes starting in ten minutes (A210E4CA). So each child
 * waits a share of ten minutes of its own, drawn at random, and then
 * rolls only while the CPU's `some avg60` is under the bar a council's
 * round waits on. Found busy, it waits its share again before it next
 * asks, so the children held for room go out spread as the CPU falls
 * rather than at their next looks together. Busy past an hour of
 * waiting, it rolls anyway, saying so: a child kept on stale code for
 * hours is the cost the roll exists to end.
 *
 * A step back is the exception. An operator moves the install's
 * `current` back to an older version to take a bad release off the
 * machine, and held to the hour, the spread and the room, each child
 * stayed on that release for one to two hours after (F33, 27 November).
 * So a child that finds its install names a version older than its own
 * rolls at that look, waiting for none of them; every other move keeps
 * its pace. To find a step back within its hour, it looks each look
 * then too, rather than once its hour is up.
 *
 * Its hour and its wait are timed on a clock that only moves forward,
 * so a wall clock put back holds no roll longer, and one put forward
 * hurries none.
 */

import { cpuShort } from "../../lib/internal/machine/room.ts";
import { installMovesOrThrowsFrom } from "./what-starts.ts";

/** How often a child looks at its install: often enough that a roll waits minutes, not hours. */
export const LOOK_EVERY_MS = 5 * 60_000;

/** How long a child runs before it may roll: a conversation rolls at most once in this. */
export const ROLL_ONLY_AFTER_MS = 60 * 60_000;

/** The span a machine's children spread their rolls across, each a random share of it. */
export const ROLL_SPREAD_MS = 10 * 60_000;

/** How long a child waits for the machine's room before it rolls anyway. */
export const ROLL_WAITS_FOR_ROOM_AT_MOST_MS = 60 * 60_000;

const MINUTE_MS = 60_000;

/** Epoch-shaped milliseconds that a wall clock's steps never move. */
const steadyNow = (): number => performance.timeOrigin + performance.now();

/** How a roll looks again after a wait; a test passes its own timers. */
export type After = (ms: number, run: () => void) => () => void;

const realAfter: After = (ms, run) => {
	const timer = setTimeout(run, ms);
	timer.unref();
	return () => clearTimeout(timer);
};

/**
 * Look at `moved` each `lookMs` and, the first time it says why the
 * host's code is stale, roll with that reason and stop looking, since
 * stale code stays stale. A look that throws says what it was looking
 * for, unless it throws as the look before it did, and looks again,
 * keeping whatever it was waiting for, since it couldn't tell; the
 * first look that answers after one says it can tell again, so the
 * journal shows the doubt ended. A child's wiring asks
 * `installMovesOrThrowsFrom`, which throws for an install it can't
 * read or one not done installing. Stale before `rollsFrom`, it says
 * so and looks again then, rolling with what the install says at that
 * look. Past that, it waits `spreadMs`, and then rolls only while
 * `roomShort` says nothing; while it says why not, it looks again after
 * `lookMs` and `spreadMs` again, rolling anyway once it has waited
 * `waitsForRoomAtMostMs`. A look finding the code current again, as
 * after a rollback, forgets the waiting, saying so when it was waiting.
 * A look finding the code stale asks `back` too, and once it says the
 * install stepped back to a version older than its own, it rolls at
 * once, before its `rollsFrom`, its spread and its room; given `back`,
 * it looks each `lookMs` before `rollsFrom` too, so it finds a step back
 * at the next look. A `back` that throws is no step back.
 * Answers the function that stops
 * looking, which holds even over a look already under way.
 */
export function rollWhenStale(
	moved: () => Promise<string | undefined>,
	roll: (why: string) => void,
	options: {
		lookMs?: number;
		after?: After;
		report?: (message: unknown) => void;
		/** The moment, in `now`'s milliseconds, before which it never rolls. */
		rollsFrom?: number;
		now?: () => number;
		/** How long it waits, once it may roll, before it first asks for room. */
		spreadMs?: number;
		/** Why the machine has no room for a roll now, or nothing when it has. */
		roomShort?: () => Promise<string | undefined>;
		waitsForRoomAtMostMs?: number;
		/** Whether the install stepped back to a version older than this one's own. */
		back?: () => Promise<boolean>;
	} = {},
): () => void {
	const lookMs = options.lookMs ?? LOOK_EVERY_MS;
	const after = options.after ?? realAfter;
	const now = options.now ?? steadyNow;
	const rollsFrom = options.rollsFrom ?? 0;
	const spreadMs = options.spreadMs ?? 0;
	const waitsAtMost =
		options.waitsForRoomAtMostMs ?? ROLL_WAITS_FOR_ROOM_AT_MOST_MS;
	let toldTooSoon = false;
	// What it last said it couldn't tell, so an install that stays
	// unreadable is said once, not at every look of every child.
	let toldUnsure: string | undefined;
	let spread = false;
	let waitingSince: number | undefined;
	let stopped = false;
	let cancel = (): void => undefined;
	const look = async () => {
		let why: string | undefined;
		try {
			why = await moved();
		} catch (error) {
			if (stopped) return;
			const said = error instanceof Error ? error.message : String(error);
			if (said !== toldUnsure)
				options.report?.(
					`Couldn't tell whether the install's host code moved on, so it looks again: ${said}`,
				);
			toldUnsure = said;
			// Not knowing isn't finding the code current: what it waited
			// for stands, so its hour of waiting for room still bounds it.
			cancel = after(lookMs, () => void look());
			return;
		}
		if (stopped) return;
		if (toldUnsure !== undefined)
			options.report?.(
				"It can tell again whether the install's host code moved on",
			);
		toldUnsure = undefined;
		if (why !== undefined) {
			const back = await steppedBack(options.back);
			if (stopped) return;
			if (back) {
				options.report?.(
					`${capitalised(why)}, a step back to a version older than its own, so it rolls now, waiting for neither its hour, its spread nor the machine's room`,
				);
				stopped = true;
				roll(why);
				return;
			}
		}
		if (why === undefined) {
			if (waitingSince !== undefined || toldTooSoon)
				options.report?.(
					"The install's host code is current again, so it no longer waits to roll",
				);
			toldTooSoon = false;
			spread = false;
			waitingSince = undefined;
			cancel = after(lookMs, () => void look());
			return;
		}
		const early = rollsFrom - now();
		if (early > 0) {
			if (!toldTooSoon) options.report?.(tooSoon(why, early, options.back));
			toldTooSoon = true;
			// Only a step back could end its hour early, so only one it may
			// hear of has it look before its hour is up.
			const next = options.back ? Math.min(early, lookMs) : early;
			cancel = after(next, () => void look());
			return;
		}
		if (!spread) {
			spread = true;
			if (spreadMs > 0) {
				cancel = after(spreadMs, () => void look());
				return;
			}
		}
		const short = await shortOf(options.roomShort);
		if (stopped) return;
		if (short !== undefined) {
			const first = waitingSince === undefined;
			waitingSince ??= now();
			const waited = now() - waitingSince;
			if (waited < waitsAtMost) {
				if (first)
					options.report?.(
						`${capitalised(why)}, but the machine is busy (${short}), so it looks again each ${minutes(lookMs + spreadMs)} until it has room, rolling anyway at its first look past ${minutes(waitsAtMost)}`,
					);
				// Its share again before it next asks, so the children held
				// for room don't all go at the first look the CPU allows.
				spread = false;
				cancel = after(lookMs, () => void look());
				return;
			}
			options.report?.(
				`It waited ${minutes(waited)} for the machine's room, so it rolls though the machine is busy (${short})`,
			);
		}
		stopped = true;
		roll(why);
	};
	cancel = after(lookMs, () => void look());
	return () => {
		stopped = true;
		cancel();
	};
}

/**
 * Why the machine has no room, or nothing; a reading that fails says
 * nothing, since a roll held on a reading that never comes would never
 * happen.
 */
async function shortOf(
	roomShort: (() => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
	try {
		return await roomShort?.();
	} catch {
		// An unreadable machine is taken as having room, as a Mac does.
		return undefined;
	}
}

/** Whether the install stepped back; a reading that fails says not, so the roll keeps its pace. */
async function steppedBack(
	back: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
	try {
		return (await back?.()) === true;
	} catch {
		// Not knowing of a step back is the pace every other move keeps.
		return false;
	}
}

/** What a child says, once, as it finds the code stale within its hour. */
function tooSoon(
	why: string,
	early: number,
	back: (() => Promise<boolean>) | undefined,
): string {
	if (back)
		return `${capitalised(why)}, but it may not roll for ${minutes(early)} yet, unless the install steps back to a version older than its own`;
	return `${capitalised(why)}, but it may not roll yet, so it looks again in ${minutes(early)}`;
}

function capitalised(words: string): string {
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function minutes(ms: number): string {
	const count = Math.ceil(ms / MINUTE_MS);
	return count === 1 ? "a minute" : `${count} minutes`;
}

/** What a child's roll is wired to: its install, its host and its life. */
export interface ChildRoll {
	/** The folder of the version the child runs, whose install it asks. */
	readonly version: string;
	/**
	 * Why the install's host code differs from the child's, or nothing,
	 * throwing when it can't tell; asked of `version`'s install, as
	 * `installMovesOrThrowsFrom` asks, if left out.
	 */
	readonly moved?: () => Promise<string | undefined>;
	/** The host holding the conversation, once its engine is being made. */
	readonly host: () => { roll(): void } | undefined;
	/** Settles, either way, as the child's host stops. */
	readonly stopped: Promise<unknown>;
	readonly report: (message: unknown) => void;
	readonly lookMs?: number;
	readonly after?: After;
	/** When the child started, in `now`'s milliseconds; the wiring's moment if left out. */
	readonly bornAt?: number;
	readonly now?: () => number;
	/** How long past its hour it waits before asking for room; a random share of `ROLL_SPREAD_MS` if left out. */
	readonly spreadMs?: number;
	/** Why the machine has no room for a roll; the CPU's pressure if left out. */
	readonly roomShort?: () => Promise<string | undefined>;
	/** Whether the install stepped back to a version older than the child's own; never, if left out. */
	readonly back?: () => Promise<boolean>;
}

/**
 * Roll a child's conversation once its install's host code moves on:
 * say why, and roll the host holding it then, though never within an
 * hour of the child's start, and past that only after its spread and
 * while the machine has room, unless its install stepped back to a
 * version older than its own, when it rolls at once. It looks until
 * the child's host stops, however that ends.
 */
export function rollChildWhenStale(wiring: ChildRoll): void {
	const now = wiring.now ?? steadyNow;
	const bornAt = wiring.bornAt ?? now();
	const stop = rollWhenStale(
		// Not knowing must throw, so it keeps what the roll waited for.
		wiring.moved ?? installMovesOrThrowsFrom(wiring.version),
		(why) => {
			wiring.report(
				`Rolling onto new code, as ${why}: the conversation parks at its next quiet moment unless a window views it`,
			);
			wiring.host()?.roll();
		},
		{
			report: wiring.report,
			rollsFrom: bornAt + ROLL_ONLY_AFTER_MS,
			now,
			spreadMs: wiring.spreadMs ?? Math.floor(Math.random() * ROLL_SPREAD_MS),
			roomShort: wiring.roomShort ?? (() => cpuShort()),
			...(wiring.lookMs === undefined ? {} : { lookMs: wiring.lookMs }),
			...(wiring.after ? { after: wiring.after } : {}),
			...(wiring.back ? { back: wiring.back } : {}),
		},
	);
	wiring.stopped.then(stop, stop);
}
