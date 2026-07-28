/**
 * What a review session accumulates.
 *
 * A person's review is not what a forge calls a review. It
 * mixes new anchored remarks with replies into threads
 * somebody else started, resolutions, reactions and a
 * verdict, and no backend accepts that mixture as one
 * operation. So the mixture is held here, addressable and
 * serializable, and the work of turning it into whatever the
 * backend will accept happens later, once and visibly.
 *
 * The state is plain data and every operation returns a new
 * one. That is what lets a draft be persisted after each
 * change, rendered without a provider, and tested without
 * either.
 */

import type { Anchor } from "../anchor.js";
import type { ReviewTarget } from "../change.js";
import type { Message, Reaction, Thread, Verdict } from "../conversation.js";

/** A new anchored remark. */
export interface FindingItem {
	kind: "finding";
	id: string;
	anchor: Anchor;
	body: string;
}

/** A reply into a thread that already exists. */
export interface ReplyItem {
	kind: "reply";
	id: string;
	/** The whole thread: providers key replies differently. */
	thread: Thread;
	body: string;
}

/** A resolution of a thread that already exists. */
export interface ResolutionItem {
	kind: "resolution";
	id: string;
	thread: Thread;
}

/** A reaction to a message. */
export interface ReactionItem {
	kind: "reaction";
	id: string;
	subject: Message;
	reaction: Reaction;
}

/** One thing the review will do. */
export type DraftItem = FindingItem | ReplyItem | ResolutionItem | ReactionItem;

/** A review being composed. */
export interface DraftState {
	id: string;
	target: ReviewTarget;
	items: DraftItem[];
	verdict?: Verdict;
	/** The summary that accompanies the verdict. */
	summary?: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * Highest item number handed out so far. Ids stay stable
	 * across removals, so this only ever climbs.
	 */
	lastNumber: number;
}

/** A fresh draft about a target. */
export function emptyDraft(id: string, target: ReviewTarget): DraftState {
	const now = new Date().toISOString();
	return {
		id,
		target,
		items: [],
		createdAt: now,
		updatedAt: now,
		lastNumber: 0,
	};
}

/**
 * Append an item, handing it the next number. Numbers are
 * never reused, so a finding a person referred to by number
 * keeps that number even after an earlier one is dropped.
 */
function append(
	state: DraftState,
	build: (id: string) => DraftItem,
): DraftState {
	const next = state.lastNumber + 1;
	return {
		...state,
		items: [...state.items, build(String(next))],
		lastNumber: next,
		updatedAt: new Date().toISOString(),
	};
}

/** Add a new anchored remark. */
export function addFinding(
	state: DraftState,
	finding: { anchor: Anchor; body: string },
): DraftState {
	return append(state, (id) => ({
		kind: "finding",
		id,
		anchor: finding.anchor,
		body: finding.body,
	}));
}

/** Add a reply into an existing thread. */
export function addReply(
	state: DraftState,
	thread: Thread,
	body: string,
): DraftState {
	return append(state, (id) => ({ kind: "reply", id, thread, body }));
}

/** Mark an existing thread to be resolved. */
export function addResolution(state: DraftState, thread: Thread): DraftState {
	return append(state, (id) => ({ kind: "resolution", id, thread }));
}

/** React to a message. */
export function addReaction(
	state: DraftState,
	subject: Message,
	reaction: Reaction,
): DraftState {
	return append(state, (id) => ({ kind: "reaction", id, subject, reaction }));
}

/** Choose the verdict and its summary. */
export function setVerdict(
	state: DraftState,
	verdict: Verdict,
	summary?: string,
): DraftState {
	return {
		...state,
		verdict,
		summary,
		updatedAt: new Date().toISOString(),
	};
}

/** Drop an item by id. Ignores an id that is not there. */
export function removeItem(state: DraftState, id: string): DraftState {
	const items = state.items.filter((item) => item.id !== id);
	if (items.length === state.items.length) return state;
	return { ...state, items, updatedAt: new Date().toISOString() };
}
