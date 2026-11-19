/**
 * A reply withheld as pi finalized it, said on the bus.
 *
 * An extension can replace a finished reply at `message_end`, and pi
 * hands the replacement to the handlers after it, but not to those
 * before it: those run in the order pi loads extensions, which is the
 * order the folder lists them in. So one that relays a reply elsewhere,
 * as the mesh's talks do to the launcher, may already have passed the
 * text on. Said here, it can put what stands in its place there too.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Said on the bus when a finished reply is withheld. */
export const REPLY_WITHHELD = "reply:withheld:v1";

/** A withheld reply: the message as written, and as it now stands. */
export interface ReplyWithheld {
	readonly was: unknown;
	readonly now: unknown;
}

/** Whether a payload is a withheld reply, as this version says one. */
function isReplyWithheld(data: unknown): data is ReplyWithheld {
	return (
		typeof data === "object" && data !== null && "was" in data && "now" in data
	);
}

/** Say that a finished reply was withheld, and what stands in its place. */
export function sayReplyWithheld(
	bus: EventBus | undefined,
	withheld: ReplyWithheld,
): void {
	bus?.emit(REPLY_WITHHELD, withheld);
}

/** Hear each reply withheld. Returns a disposer. */
export function onReplyWithheld(
	bus: EventBus | undefined,
	listener: (withheld: ReplyWithheld) => void,
): () => void {
	return (
		bus?.on(REPLY_WITHHELD, (data) => {
			if (isReplyWithheld(data)) listener(data);
		}) ??
		(() => {
			// No bus, so nothing was heard and nothing needs letting go.
		})
	);
}
