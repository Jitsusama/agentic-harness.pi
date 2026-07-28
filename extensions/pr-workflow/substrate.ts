/**
 * Borrowing the review substrate.
 *
 * This workflow does not host the substrate; the
 * review-integration extension does. Going through the host's own
 * engine rather than building one is what makes a change from a
 * downstream provider readable here: a private engine would
 * resolve against a private registry and see only the providers
 * it registered itself.
 *
 * The handshake runs both ways because the bus does not replay. If
 * the host loaded first, its announcement is already gone by the
 * time this extension activates, so this extension asks; if the
 * host loads later, its announcement arrives on its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import {
	type BoundTarget,
	type ChangeRef,
	type ConversationFacet,
	REVIEW_READY,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewSubstrateApi,
	type Thread,
} from "../../lib/review/index.js";
import { metadataFromProposal, type PrMetadata } from "./fetch.js";
import { changeFromGitHubView } from "./reference.js";
import { type ReviewThread, readConversation } from "./threads.js";

let substrate: ReviewSubstrateApi | undefined;

/** Whether a value looks like the api the host hands out. */
function isSubstrateApi(value: unknown): value is ReviewSubstrateApi {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ReviewSubstrateApi>;
	return (
		typeof candidate.engine === "function" &&
		typeof candidate.registerProvider === "function"
	);
}

/**
 * Listen for the substrate and ask for it, so this extension finds
 * the host whichever order the two of them loaded in.
 */
export function attachSubstrate(pi: ExtensionAPI): void {
	pi.events.on(REVIEW_READY, (data: unknown) => {
		if (isSubstrateApi(data)) substrate = data;
	});
	pi.events.emit(REVIEW_REQUEST_SUBSTRATE, undefined);
}

/** Hand the workflow a substrate directly. For tests. */
export function setSubstrateApi(api: ReviewSubstrateApi): void {
	substrate = api;
}

/** Drop the borrowed substrate. For tests and reloads. */
export function forgetSubstrate(): void {
	substrate = undefined;
}

/**
 * The loaded change's metadata, read through the substrate.
 *
 * Refuses when the target has no hosted change behind it, which a
 * local range or an unposted stack does not, since there is then
 * no proposal to describe.
 */
export async function metadataFromSubstrate(
	reference: PRReference,
): Promise<PrMetadata> {
	const named = changeFromGitHubView(reference);
	const bound = await boundFor(named.label);
	const proposal = await bound.proposal();
	if (!proposal) {
		throw new Error(
			`Nothing hosts ${named.label}, so there is no pull request to ` +
				"describe. A local range or an unposted stack reviews fine " +
				"but has no proposal behind it.",
		);
	}
	return metadataFromProposal(proposal);
}

/**
 * The tip of the branch a change proposes, when anyone knows it.
 *
 * Used to notice that a change moved under a review in progress.
 * Every absence answers undefined rather than throwing: a target
 * with no proposal behind it, or a provider that does not report a
 * tip, both mean the same thing to a drift check, which is that it
 * has nothing to compare against. Throwing would turn "cannot
 * tell" into "has moved".
 */
export async function headCommitFromSubstrate(
	reference: PRReference,
): Promise<string | undefined> {
	const named = changeFromGitHubView(reference);
	const bound = await boundFor(named.label);
	const proposal = await bound.proposal();
	return proposal?.headCommit;
}

/**
 * Reply into a thread through the substrate. Returns the new
 * comment's url, when the provider reports one.
 *
 * Keyed by the whole record rather than the id, because the
 * contract does not say which part of a thread addresses a reply:
 * one backend uses the thread, another the comment that opened
 * it.
 */
export async function replyThroughSubstrate(
	reference: PRReference,
	thread: ReviewThread,
	body: string,
): Promise<string | undefined> {
	const { conversation, change } = await conversationFor(reference);
	const posted = await conversation.reply(change, sourceOf(thread), body);
	// Absent when the provider does not report a link for what it
	// created. The reply still landed, so this is not an error.
	return posted.url;
}

/**
 * Resolve a thread through the substrate. Answers with the state
 * the thread is now in.
 *
 * The facet reports success by completing rather than by returning
 * a state, so a return here means the provider considers it
 * resolved. Reading the state back would be a second round trip to
 * learn what the absence of an error already said.
 */
export async function resolveThroughSubstrate(
	reference: PRReference,
	thread: ReviewThread,
): Promise<boolean> {
	const { conversation, change } = await conversationFor(reference);
	await conversation.resolve(change, sourceOf(thread));
	return true;
}

/**
 * The record a write has to be keyed by.
 *
 * Refuses rather than reconstructing one from the id. A rebuilt
 * record would satisfy GitHub and address the wrong comment on a
 * backend that keys by the opening comment, which is the kind of
 * wrong that looks like it worked.
 */
function sourceOf(thread: ReviewThread): Thread {
	if (!thread.source) {
		throw new Error(
			`Thread ${thread.id} was read before this session knew to keep ` +
				"the provider's own record of it, so a write cannot be keyed " +
				"safely. Run pr_workflow action=threads to refresh the list, " +
				"then try again.",
		);
	}
	return thread.source;
}

/**
 * The loaded change's conversation, read through the substrate.
 *
 * Shaped to the seam the actions already inject, so the reads move
 * across without every call site learning about providers.
 */
export async function threadsFromSubstrate(
	reference: PRReference,
): Promise<ReviewThread[]> {
	const { conversation, change } = await conversationFor(reference);
	return readConversation(conversation, change);
}

/**
 * The conversation for a reference, and the change to address it
 * by. Refuses with guidance rather than returning nothing.
 */
async function boundFor(label: string): Promise<BoundTarget> {
	if (!substrate) {
		throw new Error(
			"The review substrate never announced itself, so this pull " +
				"request cannot be reached. The review-integration extension " +
				"is what provides it: check that it is installed and enabled.",
		);
	}
	const engine = await substrate.engine();
	// Resolved by the name a person writes, rather than bound
	// directly, so the provider that claims it is chosen the same
	// way it would be anywhere else.
	return engine.resolve(label);
}

async function conversationFor(
	reference: PRReference,
): Promise<{ conversation: ConversationFacet; change: ChangeRef }> {
	const named = changeFromGitHubView(reference);
	const bound = await boundFor(named.label);
	if (!bound.conversation) {
		throw new Error(
			`Nothing hosts a conversation for ${named.label}, so there ` +
				"is nothing to read or reply to. A local range or an " +
				"unposted stack reviews fine but has nowhere to hold a " +
				"discussion.",
		);
	}
	const target = bound.target;
	return {
		conversation: bound.conversation,
		change: target.kind === "proposal" ? target.change : named,
	};
}
