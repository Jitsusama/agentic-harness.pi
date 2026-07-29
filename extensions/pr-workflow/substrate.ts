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
import {
	type AnchoredComment,
	type BoundTarget,
	type ChangeRef,
	type ConversationFacet,
	type DraftState,
	type PublishOutcome,
	type PublishPlan,
	REVIEW_READY,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewEngine,
	type ReviewSubstrateApi,
	type Thread,
	type Verdict,
} from "../../lib/review/index.js";
import { metadataFromProposal, type PrMetadata } from "./fetch.js";
import type { ReviewComment } from "./post.js";
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
	named: ChangeRef,
): Promise<PrMetadata> {
	const bound = await boundFor(named);
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
 * One file's contents at a commit, from whoever hosts the change.
 *
 * The diff only carries the lines that changed, so showing a
 * person the whole file means fetching it, and where it is
 * fetched from matters. A repository can be mirrored, and reading
 * the mirror returns content that looks right and may be stale or
 * absent.
 *
 * Answers null when the provider has no way to serve a file, or
 * when there is no substrate to ask. The caller decides what to
 * do about it, which for a GitHub change is to fall back to the
 * CLI it already had.
 */
export async function fileFromSubstrate(
	change: ChangeRef,
	path: string,
	at: string,
): Promise<string | null> {
	if (!substrate) return null;
	const engine = await substrate.engine();
	const bound = await engine.resolve(change.label);
	const fileAt = bound.provider.proposals?.fileAt;
	if (!fileAt) return null;
	return fileAt.call(bound.provider.proposals, change, path, at);
}

/**
 * The change a reference names, whichever system owns it.
 *
 * This is how the workflow stopped being a GitHub workflow. It
 * used to parse a reference itself, which meant it could only
 * recognize the shapes GitHub uses and could only ever conclude
 * that a change was GitHub's. The substrate knows every provider
 * registered in the session, including ones that live in another
 * package entirely, so asking it first is what lets a Meteorite
 * change, or anything added later, load at all.
 *
 * Answers null for every kind of not-knowing: no substrate to
 * ask, nothing claimed the reference, or a target that resolved
 * to something other than a hosted change, which a local range
 * legitimately does. The caller falls back to parsing a GitHub
 * reference itself, which is what happened before any of this
 * existed.
 */
export async function changeFor(input: string): Promise<ChangeRef | null> {
	if (!substrate) return null;
	try {
		const engine = await substrate.engine();
		const bound = await engine.resolve(input, process.cwd());
		return bound.target.kind === "proposal" ? bound.target.change : null;
	} catch {
		// Not knowing which change a reference names is an ordinary
		// outcome, not a fault. The load path has its own message for
		// it, and it reads better than a resolver error to somebody
		// who just typed a number.
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
export async function diffFromSubstrate(change: ChangeRef): Promise<string> {
	const bound = await boundFor(change);
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
	ref: ChangeRef;
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
	ref: ChangeRef;
	draft: DraftState;
}): Promise<PublishOutcome> {
	const prepared = await prepareDraftThroughSubstrate(input);
	return prepared.publish(input.draft.summary ?? "");
}

/**
 * A composed review, staged against its provider and ready to go.
 *
 * The plan comes back before anything is sent, so the gate can
 * show what will actually happen: which remarks anchor, which
 * degrade to the body, and what the provider refused. Those are
 * facts about a particular backend's diff and limits, so guessing
 * them earlier is how a gate ends up promising one thing and
 * posting another.
 */
export async function prepareDraftThroughSubstrate(input: {
	ref: ChangeRef;
	draft: DraftState;
}): Promise<PreparedPublish> {
	const engine = await engineOrThrow();
	const bound = await engine.bound(input.ref);
	const draft = await engine.openDraft(bound.target);

	for (const item of input.draft.items) {
		if (item.kind !== "finding") continue;
		await draft.addFinding({ anchor: item.anchor, body: item.body });
	}

	const verdict = input.draft.verdict ?? "comment";
	const diff = await bound.diffModel();

	return {
		plan: () => draft.plan({ capabilities: bound.capabilities, diff }),
		async publish(summary: string) {
			// The summary is set last, because the gate can edit it and
			// what the person approved is what should be sent.
			await draft.setVerdict(verdict, summary);
			return draft.publish(
				draft.plan({ capabilities: bound.capabilities, diff }),
				bound.provider,
			);
		},
	};
}

/** A staged review: what it will do, and a way to do it. */
export interface PreparedPublish {
	plan(): PublishPlan;
	publish(summary: string): Promise<PublishOutcome>;
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
export async function stackFromSubstrate(named: ChangeRef): Promise<Stack> {
	const bound = await boundFor(named);
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
	named: ChangeRef,
): Promise<string | undefined> {
	const bound = await boundFor(named);
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
	reference: ChangeRef,
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
	reference: ChangeRef,
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
	reference: ChangeRef,
): Promise<ReviewThread[]> {
	const { conversation, change } = await conversationFor(reference);
	return readConversation(conversation, change);
}

/**
 * The conversation for a reference, and the change to address it
 * by. Refuses with guidance rather than returning nothing.
 */
async function boundFor(change: ChangeRef): Promise<BoundTarget> {
	if (!substrate) {
		throw new Error(
			"The review substrate never announced itself, so this pull " +
				"request cannot be reached. The review-integration extension " +
				"is what provides it: check that it is installed and enabled.",
		);
	}
	const engine = await substrate.engine();
	// Bound to the system the change already names, not resolved
	// again from its name. Claiming depends on the directory the
	// question is asked from, so re-resolving can reach a different
	// provider than the one the change was loaded from, and a
	// repository with a mirror is exactly where that goes wrong.
	return engine.bound(change);
}

async function conversationFor(
	named: ChangeRef,
): Promise<{ conversation: ConversationFacet; change: ChangeRef }> {
	const bound = await boundFor(named);
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
