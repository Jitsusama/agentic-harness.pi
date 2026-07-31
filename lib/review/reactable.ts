/**
 * Addressing one comment out of a conversation.
 *
 * A thread has an address a person can read and repeat: the listing numbers
 * threads `[T1]`, `[T2]`, and every tool that acts on one takes that number.
 * The rule that goes with it is stated in the tool's own guidelines: refer to
 * a thread by the index the listing shows, never invent one.
 *
 * A comment had no such address. Reacting to one needed a provider's internal
 * id, `rc:2098169118733` on GitHub, which no listing printed anywhere, so the
 * only way to name a comment was to guess at a number the surface had never
 * shown. The rule against inventing ids was stated and, for reactions, not
 * backed by anything.
 *
 * So comments are numbered too, and the numbering lives here rather than in a
 * renderer because it has to survive being computed twice: once to render a
 * listing and again to resolve what somebody read off it. Those are separate
 * reads of the conversation, and a number meaning one comment in the listing
 * and another at resolution would be worse than no number at all.
 *
 * What keeps them agreeing is that the address says which kind of comment it
 * is. A remark inside a thread is `[C1]` upward; a top-level message is `[M1]`
 * upward. Because the two families are numbered apart, a caller holding only
 * the threads computes exactly the labels a caller holding the whole
 * conversation computes for those same threads, and the listing that shows
 * only messages does not have to fetch every thread to number them. Sharing
 * one space would have made every listing read the whole conversation to
 * print an address for a part of it.
 */

import type { Message, Thread } from "./conversation.js";

/** Which family a comment's address belongs to. */
export type ReactableKind = "comment" | "message";

/** One comment, with the address a listing prints for it. */
export interface Reactable {
	/** Whether it sits in a thread or stands on its own. */
	kind: ReactableKind;
	/** The 1-based number within its own family. */
	index: number;
	/** The address itself, as `[C3]`, so a renderer does not rebuild it. */
	label: string;
	/** The comment, whole, for handing to a provider. */
	message: Message;
	/** The thread it sits in, when it sits in one. */
	thread?: Thread;
}

/** The letter each family is addressed by. */
const LETTER: Record<ReactableKind, string> = {
	comment: "C",
	message: "M",
};

/** The address a listing prints for the nth comment of a kind. */
export function reactableLabel(kind: ReactableKind, index: number): string {
	return `[${LETTER[kind]}${index}]`;
}

/**
 * Number every comment in a conversation, or in the part of one to hand.
 *
 * Both arguments are optional because the two listings that print these
 * addresses each hold half the conversation, and neither should have to fetch
 * the other half to number what it already has.
 *
 * Order within a family is by the provider's own order, since that is what the
 * listing shows and a number that disagreed with the line it sits on would be
 * unusable. Threads are walked in the order given for the same reason.
 */
export function reactables(conversation: {
	threads?: Thread[];
	messages?: Message[];
}): Reactable[] {
	const found: Reactable[] = [];
	let comments = 0;
	for (const thread of conversation.threads ?? []) {
		for (const message of thread.comments) {
			comments += 1;
			found.push({
				kind: "comment",
				index: comments,
				label: reactableLabel("comment", comments),
				message,
				thread,
			});
		}
	}
	let messages = 0;
	for (const message of conversation.messages ?? []) {
		messages += 1;
		found.push({
			kind: "message",
			index: messages,
			label: reactableLabel("message", messages),
			message,
		});
	}
	return found;
}

/**
 * What a listing needs to print an address beside each comment.
 *
 * By comment id, because a renderer walks the conversation in its own shape
 * and should not have to search a list to find the label for the line it is
 * on.
 */
export function reactableAddresses(among: Reactable[]): Map<string, string> {
	return new Map(among.map((one) => [one.message.id, one.label]));
}

/** What went wrong when a comment could not be found. */
export interface ReactableRefusal {
	reason: string;
}

/**
 * Resolve what somebody typed into the comment they meant.
 *
 * Takes the `[C3]` or `[M1]` a listing printed, or a provider's own id for the
 * times one is to hand from elsewhere. The address is the discoverable form
 * and the reason this exists; the raw id stays accepted because a caller who
 * already holds one should not have to go and find its number.
 *
 * A bare number is refused rather than guessed at. It is ambiguous between the
 * two families, and picking one would react to the wrong comment about half
 * the time while looking like it worked.
 *
 * Every refusal says where the right answer comes from, since being told a
 * number is wrong without being told where numbers come from leaves a caller
 * guessing exactly as it was before.
 */
export function findReactable(
	asked: string,
	among: Reactable[],
): Reactable | ReactableRefusal {
	const wanted = asked.trim();
	if (wanted === "") {
		return { reason: "Naming a comment needs something to go on." };
	}

	const addressed = /^\[?([CcMm])(\d+)\]?$/.exec(wanted);
	if (addressed) {
		const kind: ReactableKind =
			addressed[1].toLowerCase() === "c" ? "comment" : "message";
		const at = Number(addressed[2]);
		const family = among.filter((one) => one.kind === kind);
		const found = family.find((one) => one.index === at);
		if (found) return found;
		const where =
			kind === "comment"
				? "Read the threads; the listing addresses every remark in them."
				: "Read the messages; the listing addresses each one.";
		return {
			reason:
				family.length === 0
					? `There are no ${kind === "comment" ? "thread remarks" : "top-level messages"} on this change to react to.`
					: `There is no ${reactableLabel(kind, at)} on this change; that family runs ${reactableLabel(kind, 1)} to ${reactableLabel(kind, family.length)}. ${where}`,
		};
	}

	if (/^\d+$/.test(wanted)) {
		return {
			reason: `A bare ${wanted} does not say which comment: ${reactableLabel("comment", Number(wanted))} is a remark in a thread and ${reactableLabel("message", Number(wanted))} is a top-level message. Use the address the listing prints.`,
		};
	}

	const byId = among.find((one) => one.message.id === wanted);
	if (byId) return byId;
	return {
		reason: `Nothing on this change has the id ${wanted}. Read the threads or the messages and use the address the listing prints, which is what this is for.`,
	};
}

/** Whether resolving a comment failed. */
export function isReactableRefusal(
	outcome: Reactable | ReactableRefusal,
): outcome is ReactableRefusal {
	return "reason" in outcome;
}
