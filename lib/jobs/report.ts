/**
 * How a message saying background jobs' results reads, so the code that
 * sends one and the code that tells whose turn it starts agree.
 *
 * The job host's outbox writes it (extensions/job-workflow/outbox.ts),
 * and the priority workflow reads which jobs it reports, to give the run
 * it starts the typed mark when the person was waiting on one of them.
 */

import { automatedHeader } from "../internal/automated.ts";

/** How the message opens, so the model and the person know nobody typed it. */
export const OUTBOX_HEADER = automatedHeader("background work is reporting");

/**
 * The header older code sent. A result sent just before a reload is
 * seen by the code that loads after it, so both are recognised.
 */
const OLDER_HEADER = automatedHeader("background jobs are reporting");

/** Whether a message is the outbox's, from this code or older. */
export function isOutboxMessage(text: string): boolean {
	return text.startsWith(OUTBOX_HEADER) || text.startsWith(OLDER_HEADER);
}

/** The jobs an outbox message reports, by id; none for any other text. */
export function jobIdsIn(text: string): string[] {
	if (!isOutboxMessage(text)) return [];
	return [...text.matchAll(/\[(?:job )?(j\d+)\]/g)].flatMap(([, id]) =>
		id === undefined ? [] : [id],
	);
}
