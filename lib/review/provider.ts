/**
 * The provider contract: facets, not one interface.
 *
 * A monolithic interface would force every backend to
 * pretend. A bare git repo has stack topology and diffs and
 * no conversation anywhere; a forge has all of it. Rather
 * than have the repo throw from half its methods, a provider
 * implements the facets it has and consumers ask before they
 * reach.
 *
 * Claiming is separate from doing. Every registered provider
 * gets a look at a reference or a repo and says whether it
 * recognizes it, so adding a backend never means editing a
 * resolver.
 */

import type { Anchor } from "./anchor.js";
import type { Capabilities } from "./capabilities.js";
import type {
	ChangeRef,
	ChangeState,
	Proposal,
	RepoLocator,
} from "./change.js";
import type { ChecksRollup } from "./checks.js";
import type {
	Message,
	Posted,
	Reaction,
	Review,
	Thread,
	WireReview,
} from "./conversation.js";
import type { Stack } from "./stack.js";

/** What a provider is shown when asked to claim a repo. */
export interface RepoProbe {
	/** Absolute path to a local checkout, when there is one. */
	repoRoot?: string;
	/** Remote URLs configured in that checkout. */
	remoteUrls?: string[];
}

/** Which changes to list. */
export interface ChangeFilter {
	state?: ChangeState;
	/** Provider-scoped actor id. */
	author?: string;
	base?: string;
	head?: string;
	limit?: number;
}

/** Reading hosted changes. */
export interface ProposalsFacet {
	fetch(ref: ChangeRef): Promise<Proposal>;
	/** Unified diff in git's dialect. */
	diff(ref: ChangeRef): Promise<string>;
	checks?(ref: ChangeRef): Promise<ChecksRollup>;
	list?(repo: RepoLocator, filter: ChangeFilter): Promise<Proposal[]>;
	/**
	 * Materialize the change's commits in a local repo and
	 * return the ref they landed on. This is what lets a
	 * consumer diff, blame or check out a change without
	 * knowing which backend hosts it.
	 */
	fetchAsRef?(ref: ChangeRef, repoRoot: string): Promise<string>;
	/**
	 * One file's contents at a commit.
	 *
	 * For showing a person a whole file when the diff only carries
	 * the lines that changed. It belongs to the provider because
	 * the answer has to come from the system hosting the change: a
	 * repository can be mirrored, and reading the mirror returns
	 * content that is plausible and stale.
	 *
	 * Absent where a provider has no way to serve a file it does
	 * not have locally.
	 */
	fileAt?(ref: ChangeRef, path: string, at: string): Promise<string>;
}

/** A local ref, for providers that read stacks off disk. */
export interface LocalBranch {
	repo: RepoLocator;
	ref: string;
}

/** Reading stack topology. */
export interface StackingFacet {
	/**
	 * The stack containing this ref or change, with its
	 * provenance marked. Partial answers are expected: a
	 * provider reports what it can see rather than failing.
	 */
	stack(subject: ChangeRef | LocalBranch): Promise<Stack>;
}

/** Reading and writing the conversation on a change. */
export interface ConversationFacet {
	reviews(ref: ChangeRef): Promise<Review[]>;
	threads(ref: ChangeRef): Promise<Thread[]>;
	messages(ref: ChangeRef): Promise<Message[]>;
	postReview(ref: ChangeRef, review: WireReview): Promise<Posted>;
	/**
	 * Reply into a thread. Takes the whole thread because the
	 * backends key a reply differently: one by the thread,
	 * one by the comment that started it.
	 */
	reply(ref: ChangeRef, thread: Thread, body: string): Promise<Posted>;
	resolve(ref: ChangeRef, thread: Thread): Promise<void>;
	unresolve?(ref: ChangeRef, thread: Thread): Promise<void>;
	/** A remark about the change as a whole. */
	comment(ref: ChangeRef, body: string): Promise<Posted>;
	/** A standalone anchored remark, outside any review. */
	commentOn?(ref: ChangeRef, anchor: Anchor, body: string): Promise<Posted>;
	react?(ref: ChangeRef, subject: Message, reaction: Reaction): Promise<void>;
	unreact?(ref: ChangeRef, subject: Message, reaction: Reaction): Promise<void>;
}

/** A field being changed, where clearing differs from leaving. */
export type FieldEdit<T> = { action: "set"; value: T } | { action: "clear" };

/** What to change about a proposal. */
export interface ProposalEdit {
	title?: FieldEdit<string>;
	body?: FieldEdit<string>;
	base?: FieldEdit<string>;
}

/** What to propose. */
export interface ProposalDraft {
	repo: RepoLocator;
	base: string;
	head: string;
	title: string;
	body: string;
	draft?: boolean;
}

/** How a change should be integrated. */
export interface MergeRequest {
	/**
	 * Strategy, in the provider's vocabulary. Omitted when
	 * the provider offers only one, which one of them does.
	 */
	method?: string;
	/**
	 * Refuse unless the head is still this commit. Every
	 * backend surveyed supports the guard and it is the only
	 * protection against merging work you have not seen.
	 */
	expectedHead?: string;
}

/**
 * Creating and changing proposals.
 *
 * Typed now, implemented later. The shapes are here so the
 * authoring flows have a home and nothing in the reviewing
 * half gets designed into a corner that authoring cannot fit
 * through.
 */
export interface AuthoringFacet {
	propose(draft: ProposalDraft): Promise<Proposal>;
	/** Propose a whole stack in dependency order. */
	proposeStack?(drafts: ProposalDraft[]): Promise<Proposal[]>;
	edit(ref: ChangeRef, edit: ProposalEdit): Promise<Proposal>;
	setDraft?(ref: ChangeRef, draft: boolean): Promise<void>;
	close(ref: ChangeRef, comment?: string): Promise<void>;
	reopen?(ref: ChangeRef): Promise<void>;
	merge(ref: ChangeRef, request: MergeRequest): Promise<void>;
	requestReviewers?(ref: ChangeRef, actors: string[]): Promise<void>;
}

/** A backend the substrate can review through. */
export interface ReviewProvider {
	/** Stable id, e.g. `github`, `meteorite`, `git`. */
	id: string;
	/**
	 * Claim priority. Lower numbers are asked first, so a
	 * specialist can out-claim a generalist: during a mirror
	 * migration the new backend must win the repo the old one
	 * still recognizes.
	 */
	priority: number;
	/**
	 * Recognize a reference: a URL, a short form, a bare
	 * number, a branch. Returns null when it means nothing to
	 * this provider. Cheap and synchronous.
	 */
	claimReference(input: string, repo?: RepoLocator): ChangeRef | null;
	/** Recognize a repo from a checkout or its remotes. */
	claimRepo(probe: RepoProbe): RepoLocator | null;
	/** What this provider can do for this repo. */
	capabilities(repo: RepoLocator): Capabilities;

	proposals?: ProposalsFacet;
	stacking?: StackingFacet;
	conversation?: ConversationFacet;
	authoring?: AuthoringFacet;
}
