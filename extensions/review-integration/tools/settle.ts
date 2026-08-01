/**
 * What to do with a thread once a reply has landed in it.
 *
 * Answering a thread and closing it is one human intent, so the reply
 * carries the decision rather than costing a second call and a second
 * gate. Five council threads answered and closed used to be ten gates.
 *
 * The order is reply first, settle second, and it is not arbitrary: a
 * thread closed around a reply that never landed reads as agreement
 * nobody gave. The failure in the other direction is survivable and is
 * reported rather than smoothed over.
 */

import type {
	ChangeRef,
	ConversationFacet,
	Thread,
} from "../../../lib/review/index.js";

/** The settling half of a conversation, which is all this file needs. */
type Settler = Pick<ConversationFacet, "resolve" | "unresolve">;

/** What a caller asked to happen to the thread afterwards. */
export type Settle = "resolve" | "unresolve" | "leave";

/** What became of the settling. */
export interface Settled {
	/** Whether the thread actually moved. */
	settled: boolean;
	/** What to tell the caller, when there is anything to tell. */
	note?: string;
}

/**
 * Settle a thread after a reply landed in it.
 *
 * A failure here is reported rather than thrown, because the reply above
 * it has already been posted and unwinding is not on offer. Both facts go
 * back: either one alone misleads.
 */
export async function settleAfter(
	conversation: Settler,
	change: ChangeRef,
	thread: Thread,
	settle: Settle | undefined,
): Promise<Settled> {
	if (!settle || settle === "leave") return { settled: false };

	const reopening = settle === "unresolve";
	try {
		if (reopening) await conversation.unresolve?.(change, thread);
		else await conversation.resolve(change, thread);
		return { settled: true, note: reopening ? "reopened" : "resolved" };
	} catch (error) {
		const said = error instanceof Error ? error.message : String(error);
		return {
			settled: false,
			note: `the reply landed but the thread is still open: ${said}`,
		};
	}
}

/**
 * Why this settling cannot be done, before anything is posted.
 *
 * Checked up front precisely because the reply goes first. Finding out
 * afterwards that the provider cannot reopen a thread leaves a reply
 * posted under a promise nothing can keep.
 */
export function settleRefusal(
	conversation: Settler,
	settle: Settle | undefined,
	provider: string,
): string | undefined {
	if (settle !== "unresolve" || conversation.unresolve) return undefined;
	return `The ${provider} provider cannot reopen a resolved thread, so this reply was not posted either. Drop the settle, or use resolve.`;
}
