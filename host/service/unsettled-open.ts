/**
 * What a host says of an open or adopt whose child gave no answer in
 * time but runs the conversation all the same, shared by the host that
 * says it and the pi that asked. The refusal crosses the wire as an
 * error, whose shape is strict, so the conversation it names travels in
 * its words, and only this module writes or reads them. Kept apart from
 * child-requests.ts, which reads replies through the host's protocol
 * and so loads zod, since every pi loads the spawn that reads this.
 */

/** The code of a refusal naming the conversation its child runs. */
export const OPEN_UNSETTLED = "open_unsettled";

// The id is a UUID, as every session id a host answers with is: words
// naming anything else, from a broken or stale host, are no conversation
// to attach to, and the attach words count on it needing no quoting.
const SAID =
	/^The conversation's process gave no answer in time, but runs ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}): attach to it, or close it, rather than open another$/;

/** The words of a refusal naming `sessionId` as the one its child runs. */
export function unsettledMessage(sessionId: string): string {
	return `The conversation's process gave no answer in time, but runs ${sessionId}: attach to it, or close it, rather than open another`;
}

/**
 * The conversation a refusal says its child runs, or nothing for any
 * other refusal, so the caller attaches to it rather than opening another.
 */
export function unsettledSession(error: {
	readonly code: string;
	readonly message: string;
}): string | undefined {
	if (error.code !== OPEN_UNSETTLED) return undefined;
	return SAID.exec(error.message)?.[1];
}
