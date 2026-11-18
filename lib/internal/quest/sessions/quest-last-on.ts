/**
 * The quest a session was on last, as its registry record says it, for
 * the list of ended quests, which names a session only where it was last.
 */

import type { SessionRecord } from "./session-registry.ts";

/** A quest a session was on, and since when its record says so. */
export interface QuestLastOn {
	readonly quest: string;
	/** ISO: when the session moved onto it, or left it once it unloaded. */
	readonly at: string;
}

/**
 * The quest a session was on last, and since when the record says so:
 * the one it is on now, since it moved there, or, once it has unloaded,
 * the one it left most recently, as of leaving it. Undefined when it
 * was never on one. A README's `started` can't say this, since a
 * session that returns to a quest keeps the stamp of its first attach
 * there.
 *
 * A record an older install wrote says no move, and one an older install
 * moved after a newer one wrote it keeps a stale `questSince`. Its latest
 * leaving dates the move too: a session that moves from one quest onto
 * the next leaves the first as it goes, and no leaving comes after the
 * move onto the quest it is on, so the later of the two is never late.
 * After an unload and a later load the leaving is earlier than the
 * move, which errs toward the README stamps as before. One that never
 * left a quest has been on this one since it opened.
 */
export function questLastOn(record: SessionRecord): QuestLastOn | undefined {
	if (record.quest) {
		const since = readable(record.questSince);
		const left = lastLeft(record);
		const moved =
			since !== undefined && (left === undefined || since.ms >= left.ms)
				? since.at
				: left?.at;
		return { quest: record.quest, at: moved ?? record.openedAt };
	}
	const left = lastLeft(record);
	return left && { quest: left.quest, at: left.at };
}

/** An ISO time with its milliseconds, or undefined when it can't be read. */
function readable(
	at: string | undefined,
): { at: string; ms: number } | undefined {
	if (at === undefined) return undefined;
	const ms = Date.parse(at);
	return Number.isNaN(ms) ? undefined : { at, ms };
}

/** The quest the record says the session left most recently, as of leaving it. */
function lastLeft(
	record: SessionRecord,
): { quest: string; at: string; ms: number } | undefined {
	let last: { quest: string; at: string; ms: number } | undefined;
	for (const [quest, left] of Object.entries(record.previousQuests ?? {})) {
		const ms = Date.parse(left);
		if (Number.isNaN(ms)) continue;
		if (last === undefined || ms > last.ms) last = { quest, at: left, ms };
	}
	return last;
}
