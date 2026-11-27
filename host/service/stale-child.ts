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
 */

import { cpuShort } from "../../lib/internal/machine/room.ts";

/** How often a child looks at its install: often enough that a roll waits minutes, not hours. */
export const LOOK_EVERY_MS = 5 * 60_000;

/** How long a child runs before it may roll: a conversation rolls at most once in this. */
export const ROLL_ONLY_AFTER_MS = 60 * 60_000;

/** The span a machine's children spread their rolls across, each a random share of it. */
export const ROLL_SPREAD_MS = 10 * 60_000;

/** How long a child waits for the machine's room before it rolls anyway. */
export const ROLL_WAITS_FOR_ROOM_AT_MOST_MS = 60 * 60_000;

const MINUTE_MS = 60_000;

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
 * stale code stays stale. A look that throws is reported, saying what
 * it was looking for, and looks again. Stale before `rollsFrom`, it says
 * so and looks again then, rolling with what the install says at that
 * look. Past that, it waits `spreadMs`, and then rolls only while
 * `roomShort` says nothing; while it says why not, it looks again after
 * `lookMs` and `spreadMs` again, rolling anyway once it has waited
 * `waitsForRoomAtMostMs`. A look finding the code current again, as
 * after a rollback, forgets the waiting. Answers the function that stops
 * looking, which holds even over a look already under way.
 */
export function rollWhenStale(
	moved: () => Promise<string | undefined>,
	roll: (why: string) => void,
	options: {
		lookMs?: number;
		after?: After;
		report?: (message: unknown) => void;
		/** The moment, in epoch milliseconds, before which it never rolls. */
		rollsFrom?: number;
		now?: () => number;
		/** How long it waits, once it may roll, before it first asks for room. */
		spreadMs?: number;
		/** Why the machine has no room for a roll now, or nothing when it has. */
		roomShort?: () => Promise<string | undefined>;
		waitsForRoomAtMostMs?: number;
	} = {},
): () => void {
	const lookMs = options.lookMs ?? LOOK_EVERY_MS;
	const after = options.after ?? realAfter;
	const now = options.now ?? Date.now;
	const rollsFrom = options.rollsFrom ?? 0;
	const spreadMs = options.spreadMs ?? 0;
	const waitsAtMost =
		options.waitsForRoomAtMostMs ?? ROLL_WAITS_FOR_ROOM_AT_MOST_MS;
	let toldTooSoon = false;
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
			options.report?.(
				`Couldn't tell whether the install's host code moved on, so it looks again: ${said}`,
			);
		}
		if (stopped) return;
		if (why === undefined) {
			toldTooSoon = false;
			spread = false;
			waitingSince = undefined;
			cancel = after(lookMs, () => void look());
			return;
		}
		const early = rollsFrom - now();
		if (early > 0) {
			if (!toldTooSoon)
				options.report?.(
					`${capitalised(why)}, but it may not roll yet, so it looks again in ${minutes(early)}`,
				);
			toldTooSoon = true;
			cancel = after(early, () => void look());
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
						`${capitalised(why)}, but the machine is busy (${short}), so it looks again each ${minutes(lookMs + spreadMs)} until it has room, rolling anyway after ${minutes(waitsAtMost)}`,
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

function capitalised(words: string): string {
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function minutes(ms: number): string {
	const count = Math.ceil(ms / MINUTE_MS);
	return count === 1 ? "a minute" : `${count} minutes`;
}

/** What a child's roll is wired to: its install, its host and its life. */
export interface ChildRoll {
	/** Why the install's host code differs from the child's, or nothing. */
	readonly moved: () => Promise<string | undefined>;
	/** The host holding the conversation, once its engine is being made. */
	readonly host: () => { roll(): void } | undefined;
	/** Settles, either way, as the child's host stops. */
	readonly stopped: Promise<unknown>;
	readonly report: (message: unknown) => void;
	readonly lookMs?: number;
	readonly after?: After;
	/** When the child started, in epoch milliseconds; the wiring's moment if left out. */
	readonly bornAt?: number;
	readonly now?: () => number;
	/** How long past its hour it waits before asking for room; a random share of `ROLL_SPREAD_MS` if left out. */
	readonly spreadMs?: number;
	/** Why the machine has no room for a roll; the CPU's pressure if left out. */
	readonly roomShort?: () => Promise<string | undefined>;
}

/**
 * Roll a child's conversation once its install's host code moves on:
 * say why, and roll the host holding it then, though never within an
 * hour of the child's start, and past that only after its spread and
 * while the machine has room. It looks until the child's host stops,
 * however that ends.
 */
export function rollChildWhenStale(wiring: ChildRoll): void {
	const now = wiring.now ?? Date.now;
	const bornAt = wiring.bornAt ?? now();
	const stop = rollWhenStale(
		wiring.moved,
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
		},
	);
	wiring.stopped.then(stop, stop);
}
