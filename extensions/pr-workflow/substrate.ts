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
	type AnchoredComment,
	type BoundTarget,
	type ChangeRef,
	type ConversationFacet,
	type DraftState,
	type PublishOutcome,
	REVIEW_READY,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewEngine,
	type ReviewSubstrateApi,
	type Thread,
	type Verdict,
} from "../../lib/review/index.js";
import { metadataFromProposal, type PrMetadata } from "./fetch.js";
import type { ReviewComment } from "./post.js";
import { changeFromGitHubView, githubViewOf } from "./reference.js";
import { type Stack, stackViewFrom } from "./stack.js";
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
 * Which repo a bare change number means in this directory.
 *
 * Asked of the substrate rather than read off the origin remote,
 * because the resolver is what knows about configured mappings
 * and provider claims. Reading the remote directly would be wrong
 * in exactly the repos that bothered to configure something.
 *
 * Answers null for every kind of not-knowing. The load path has
 * its own message for a reference it cannot place, and it reads
 * better than a resolver error to someone who just typed a
 * number.
 */
export async function repoForBareChange(
	input: string,
): Promise<{ owner: string; repo: string } | null> {
	if (!substrate) return null;
	try {
		const engine = await substrate.engine();
		const bound = await engine.resolve(input, process.cwd());
		const change =
			bound.target.kind === "proposal" ? bound.target.change : null;
		const view = change ? githubViewOf(change) : null;
		return view ? { owner: view.owner, repo: view.repo } : null;
	} catch {
		// Not knowing which repo a number means is an ordinary
		// outcome here, not a fault: the caller falls back to asking
		// the user to spell it out.
		return null;
	}
}

/**
 * A change's unified diff, exactly as the provider produced it.
 *
 * Handed back untouched on purpose. Everything downstream parses
 * this text, so a transformation here would surface as a parsing
 * bug somewhere far less obvious.
 */
export async function diffFromSubstrate(
	reference: PRReference,
): Promise<string> {
	const bound = await boundFor(changeFromGitHubView(reference).label);
	return bound.diff();
}

/**
 * Submit a review through the substrate.
 *
 * Unlike the reads around it, this refuses rather than degrades.
 * A review that silently went nowhere is worse than one that
 * failed loudly, because the person who wrote it walks away
 * believing it landed.
 */
export async function postReviewThroughSubstrate(input: {
	ref: PRReference;
	event: string;
	body: string;
	comments: readonly ReviewComment[];
}): Promise<void> {
	const { conversation, change } = await conversationFor(input.ref);
	await conversation.postReview(change, {
		verdict: verdictOf(input.event),
		body: input.body,
		comments: input.comments.map(anchoredFrom),
	});
}

/**
 * Publish a composed review through a draft the substrate keeps.
 *
 * Posting in one shot means a half a backend rejects is simply
 * gone, and its author finds out by noticing remarks missing. A
 * draft is persisted before anything is sent and keeps whatever
 * did not land, so a partial publish can be finished rather than
 * rewritten.
 *
 * The plan is compiled against the bound provider's own
 * capabilities and diff, which is the only place the split
 * between an anchored remark and one in the body is sound.
 */
export async function publishDraftThroughSubstrate(input: {
	ref: PRReference;
	draft: DraftState;
}): Promise<PublishOutcome> {
	const engine = await engineOrThrow();
	const bound = await engine.resolve(changeFromGitHubView(input.ref).label);
	const draft = await engine.openDraft(bound.target);

	for (const item of input.draft.items) {
		if (item.kind !== "finding") continue;
		await draft.addFinding({ anchor: item.anchor, body: item.body });
	}
	if (input.draft.verdict) {
		await draft.setVerdict(input.draft.verdict, input.draft.summary);
	}

	const plan = draft.plan({
		capabilities: bound.capabilities,
		diff: await bound.diffModel(),
	});
	return draft.publish(plan, bound.provider);
}

/** The hosted engine, or the guidance for having no host. */
async function engineOrThrow(): Promise<ReviewEngine> {
	if (!substrate) {
		throw new Error(
			"The review substrate never announced itself, so this review " +
				"cannot be published. The review-integration extension is " +
				"what provides it: check that it is installed and enabled.",
		);
	}
	return substrate.engine();
}

/** A GitHub review event as the position the contract knows. */
function verdictOf(event: string): Verdict {
	if (event === "APPROVE") return "approve";
	return event === "REQUEST_CHANGES" ? "request-changes" : "comment";
}

/**
 * A review comment as an anchored one.
 *
 * The side matters more than it looks: a remark on a deleted line
 * belongs on the old blob, and posting it against the new one
 * would attach it to whatever code now occupies that number.
 */
function anchoredFrom(comment: ReviewComment): AnchoredComment {
	return {
		anchor: {
			subject: "line",
			path: comment.path,
			blob: comment.side === "LEFT" ? "old" : "new",
			line: comment.line,
			...(comment.startLine === undefined
				? {}
				: { startLine: comment.startLine }),
		},
		body: comment.body,
	};
}

/**
 * The stack a change belongs to, read through the substrate.
 *
 * Refuses when the provider does not stack at all, which is
 * different from a change that stands alone: the first has no
 * answer, the second answers with a stack of one.
 */
export async function stackFromSubstrate(
	reference: PRReference,
): Promise<Stack> {
	const named = changeFromGitHubView(reference);
	const bound = await boundFor(named.label);
	const topology = await bound.stack();
	if (!topology) {
		throw new Error(
			`Whoever hosts ${named.label} does not report stacks, so there ` +
				"is no chain to walk. Reviewing the change on its own still " +
				"works.",
		);
	}
	return stackViewFrom(topology);
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
