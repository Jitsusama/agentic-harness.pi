/**
 * The job reports a session has already shown, so one that comes again
 * can be turned away instead of starting a turn.
 *
 * The outbox never sends a report again once it has seen it land. A
 * runtime pi replaced without making it stale still holds its outbox,
 * though, and it no longer hears the session, so it never sees its
 * report land and sends it every thirty seconds until pi exits. Two
 * reloads at once on code from before reloads ran one at a time left
 * such a runtime; its code can't be reached, but its sends come in
 * through the session like any prompt, so the live runtime can drop them.
 *
 * Only exact repeats of an outbox message. The person typing the same
 * words twice is theirs to send twice.
 */

import { isOutboxMessage } from "./outbox.ts";

/** What the session has shown, and whether a prompt is a repeat of it. */
export interface ShownReports {
	/** Note a message that landed. */
	add(text: string): void;
	/** Whether `text` is a job report the session has already shown. */
	again(text: string): boolean;
}

/** Reports shown so far, starting from those `history` already holds. */
export function shownReports(history: Iterable<string>): ShownReports {
	const shown = new Set<string>();
	const add = (text: string) => {
		if (isOutboxMessage(text)) shown.add(text);
	};
	for (const text of history) add(text);
	return {
		add,
		again: (text) => isOutboxMessage(text) && shown.has(text),
	};
}
