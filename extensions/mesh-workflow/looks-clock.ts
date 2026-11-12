/**
 * What the looks clock does each minute to the person's look list on
 * this session's behalf: looks he opened that asked nothing back leave,
 * and this session's or its quest's looks past their time expire, with
 * the agent told which, so it knows they are no longer in front of him
 * (WCJQSG, 12 November).
 */

import {
	expireLooks,
	heldBy,
	type Look,
	leaveSeenLooks,
	type Pointer,
} from "../../lib/mesh/looks.ts";

/**
 * Keep the look list in `dir` current for `owner`, a session and its
 * quest; answers the looks of theirs it expired. A list that can't be
 * read or written now is kept on the next tick.
 */
export function keepLooks(
	dir: string,
	owner: Pointer,
	now: Date = new Date(),
): Look[] {
	try {
		leaveSeenLooks(dir, now);
		return expireLooks(dir, (look) => heldBy(look, owner), now);
	} catch {
		// Unreadable or unwritable now: the next tick keeps it.
		return [];
	}
}

/** What the agent reads of its looks that expired, or nothing for none. */
export function expiredText(looks: readonly Look[]): string | undefined {
	if (looks.length === 0) return undefined;
	const titles = looks.map((look) => `"${look.title}"`).join(", ");
	return `[Off the person's look list, past its time: ${titles}. Each asked nothing back and went a day unopened. Point at one again only if it matters to them now.]`;
}
