/**
 * The window a sender gives a hold, read from what it wrote: when it
 * starts holding and when it ends by itself. A peer holding for a call
 * from 12:30 to 13:00 sends it at 12:14 saying both, so nobody waits on
 * the holder remembering to end it, and nobody is held before it starts.
 */

import { clock, type Message, shortId } from "./message.ts";

/** A clock time of day, as `13:10`. */
const CLOCK = /^(\d{1,2}):(\d{2})$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a sender's window comes to: the times kept and what was left out. */
export interface WindowAsked {
	readonly window: Pick<Message, "starts" | "ends">;
	/** Why a time given was left out, one note each. */
	readonly notes: readonly string[];
}

/**
 * A time as written, an ISO time or a clock time of day on this machine,
 * as milliseconds, or nothing when it reads as neither. A clock time
 * already past today is tomorrow's, since a window is always ahead.
 */
export function timeWritten(
	written: string,
	now: number,
	after = now,
): number | undefined {
	const trimmed = written.trim();
	const clock = CLOCK.exec(trimmed);
	if (clock) {
		const hours = Number(clock[1]);
		const minutes = Number(clock[2]);
		if (hours > 23 || minutes > 59) return undefined;
		const day = new Date(now);
		day.setHours(hours, minutes, 0, 0);
		const at = day.getTime();
		return at <= after ? at + DAY_MS : at;
	}
	// A bare date or a number is no time a sender means for a window.
	if (!trimmed.includes("T")) return undefined;
	const at = Date.parse(trimmed);
	return Number.isFinite(at) ? at : undefined;
}

/**
 * What the sender of `hold` is told of how long it holds: from when, and
 * until it ends by itself or is ended.
 */
export function holdNote(
	hold: Pick<Message, "id" | "at" | "starts" | "ends">,
): string {
	const id = shortId(hold);
	const from =
		hold.starts !== undefined && Date.parse(hold.starts) > Date.parse(hold.at)
			? `It holds nobody until ${clock({ at: hold.starts })}. `
			: "";
	if (hold.ends !== undefined) {
		return `${from}It ends by itself at ${clock({ at: hold.ends })}, and every peer waiting on it then gets a turn: answer [${id}] with endsHold to end it sooner, or replace it to change it.`;
	}
	return `${from}It holds for two hours at most: answer [${id}] with endsHold, or replace it, when it is over, so whoever waits on it carries on.`;
}

/**
 * The window a send asks for, from its `startsAt` and `endsAt`: only a
 * hold has one, and an end must fall after its start, else it is left
 * out and said. The send goes on without what was left out.
 */
export function windowAsked(
	intent: Message["intent"],
	startsAt: string | undefined,
	endsAt: string | undefined,
	now: number,
): WindowAsked {
	const given = [startsAt, endsAt].some((one) => one?.trim());
	if (!given) return { window: {}, notes: [] };
	if (intent !== "hold") {
		return {
			window: {},
			notes: ["startsAt and endsAt were left out: only a hold has a window."],
		};
	}
	const notes: string[] = [];
	const starts = startsAt?.trim() ? timeWritten(startsAt, now) : undefined;
	if (startsAt?.trim() && starts === undefined) {
		notes.push(
			`startsAt "${startsAt}" was left out: it reads as neither an ISO time nor HH:MM, so it holds from now.`,
		);
	}
	const from = starts ?? now;
	const ends = endsAt?.trim() ? timeWritten(endsAt, now, from) : undefined;
	if (endsAt?.trim() && ends === undefined) {
		notes.push(
			`endsAt "${endsAt}" was left out: it reads as neither an ISO time nor HH:MM, so it holds until it is ended.`,
		);
	} else if (ends !== undefined && ends <= from) {
		notes.push(
			`endsAt "${endsAt}" was left out: it falls before the hold starts, so it holds until it is ended.`,
		);
	}
	const kept = ends !== undefined && ends > from ? ends : undefined;
	return {
		window: {
			...(starts !== undefined
				? { starts: new Date(starts).toISOString() }
				: {}),
			...(kept !== undefined ? { ends: new Date(kept).toISOString() } : {}),
		},
		notes,
	};
}
