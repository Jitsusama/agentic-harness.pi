/**
 * Why a watched session stays awake, kept where Agents and a count can
 * read it, and written only when the reason changes, not every minute.
 */

import { clearAwake, writeAwake } from "../../lib/internal/session/park.ts";

/**
 * A note of why `session` stays awake, kept in `folder` (the usual one
 * where undefined), dated as `now` reads the time. Nothing, or a park
 * already under way, clears it.
 */
export function awakeNote(
	session: string,
	folder: string | undefined,
	now: () => number,
): (why: string | undefined) => void {
	let said: string | undefined;
	return (why) => {
		if (why === said) return;
		said = why;
		try {
			if (why === undefined || why === "parking already") {
				clearAwake(session, folder);
			} else {
				writeAwake(
					{ session, why, since: new Date(now()).toISOString() },
					folder,
				);
			}
		} catch {
			// A park folder that can't be written costs the note, never the park.
		}
	};
}
