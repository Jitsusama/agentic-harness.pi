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
 * A record an older install wrote, or one whose `questSince` can't be
 * read, says no move. Its latest leaving is that move, since a session
 * leaves one quest as it moves onto the next; one that never left a
 * quest has been on this one since it opened.
 */
export function questLastOn(record: SessionRecord): QuestLastOn | undefined {
	if (record.quest) {
		const since = record.questSince;
		const moved =
			since !== undefined && !Number.isNaN(Date.parse(since))
				? since
				: lastLeft(record)?.at;
		return { quest: record.quest, at: moved ?? record.openedAt };
	}
	return lastLeft(record);
}

/** The quest the record says the session left most recently, as of leaving it. */
function lastLeft(record: SessionRecord): QuestLastOn | undefined {
	let last: { quest: string; at: string; ms: number } | undefined;
	for (const [quest, left] of Object.entries(record.previousQuests ?? {})) {
		const ms = Date.parse(left);
		if (Number.isNaN(ms)) continue;
		if (last === undefined || ms > last.ms) last = { quest, at: left, ms };
	}
	return last && { quest: last.quest, at: last.at };
}
