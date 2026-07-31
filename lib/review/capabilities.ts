/**
 * What a provider can actually do.
 *
 * Facets say which broad abilities a provider has; these say
 * how far each one goes. The distinction earns its keep at
 * the point of publishing: two providers both post reviews,
 * but one caps a batch at a hundred comments, one cannot
 * thread a reply onto a top-level message, and one has no
 * way to unresolve. A consumer that cannot ask about those
 * differences has to discover them from a rejected request,
 * which is the worst moment to find out.
 *
 * Declaring capabilities is how degradation stays loud. The
 * publish plan reads them, decides what will land and what
 * will not, and says so before anything is sent.
 *
 * Which means a capability nothing reads is not a capability,
 * it is a promise. Three were removed once an audit went
 * looking for readers and found none:
 *
 * - `suggestions`, a suggested edit a reader can apply. No
 *   finding or draft item in this substrate can carry one, so
 *   the field described a feature nothing could express.
 * - `pendingReviews`, holding a review as a draft on the
 *   backend. The draft here is local and outlives the call,
 *   which is what lets it work identically on a backend with
 *   no such notion. The capability was obsolete by design.
 * - `deleteBranchOnMerge`. The one thing the system now
 *   deliberately refuses, because GitHub permanently closes
 *   the dependent PRs and they cannot be reopened.
 *
 * A field is added here when a reader is added with it. That
 * is the whole discipline, and these three are why.
 *
 * `autoMerge` went the same way and is the interesting one,
 * because unlike those three it named something real. GitHub
 * does merge once checks pass, and the capability report
 * listed `auto-merge` among the verbs a caller was told they
 * could use. There was no verb: no method on the authoring
 * facet, no flag on a merge request, no action on the tool.
 * Advertising a door that is painted on is worse than having
 * no door, so it comes back the day it opens, which now means
 * a `whenReady` flag on {@link MergeRequest} answered with an
 * `enqueued` outcome, since that is exactly what it is.
 */

import type { Reaction, Verdict } from "./conversation.js";
import type { StackProvenance } from "./stack.js";

/** How a provider treats an anchor that no longer fits. */
export type StalenessModel =
	/** Anchors stay valid; the provider pins a witness commit. */
	| "pinned"
	/** The provider flags a stranded anchor. */
	| "flagged"
	/** The provider says nothing either way. */
	| "none";

/**
 * Where a remark about a whole file is allowed to be posted.
 *
 * `standalone` means it has to be posted on its own, outside a batch
 * review, which is what both backends surveyed require. `batch` means it can
 * ride along with a verdict and the line-anchored remarks, which is what a
 * boolean used to claim for backends that do not allow it.
 */
export type FileLevelComments = "never" | "standalone" | "batch";

/** What a provider's conversation facet can do. */
export interface ConversationCapabilities {
	/** Post a verdict and anchored comments in one submission. */
	anchoredBatchReview: boolean;
	/** Cap on comments per batch, when there is one. */
	maxBatchComments?: number;
	/**
	 * Where a remark about a whole file can be posted, if anywhere.
	 *
	 * A boolean here could not be honest, and both backends proved it. Each
	 * declared `anchoredBatchReview: true` and `fileLevelComments: true` and
	 * each statement was true on its own, while their conjunction was false:
	 * neither will take a file-level comment inside a batch review. GitHub
	 * refuses the batch with `0.position (Expected value to not be null)` and
	 * gitstream with `comments[0].line missing_field`, and in both cases the
	 * whole review is rejected rather than the one remark. Posted on its own,
	 * with a subject type of file, both accept it.
	 *
	 * So the question is not whether a file-level remark is possible but
	 * where it can go, and a capability that cannot express a conjunction
	 * will lie about one.
	 */
	fileLevelComments: FileLevelComments;
	/** Anchor a remark to a run of lines. */
	multiLineRanges: boolean;
	/** Reopen a resolved thread. */
	unresolve: boolean;
	/** Reactions the provider accepts. Empty means none. */
	reactions: readonly Reaction[];
	/** Reply onto a top-level message, not just a thread. */
	topLevelThreading: boolean;
	/** How the provider treats an anchor that no longer fits. */
	staleness: StalenessModel;
	/**
	 * Verdicts that require a summary body. One backend
	 * rejects a request for changes with an empty body.
	 */
	bodyRequiredFor?: readonly Verdict[];
	/** Verdicts allowed on a change the actor authored. */
	selfVerdicts?: readonly Verdict[];
	/** Verdicts still allowed once a change has merged. */
	verdictsAfterMerge?: readonly Verdict[];
}

/** What a provider's stacking facet can do. */
export interface StackingCapabilities {
	/** Whether the shape is recorded or inferred. */
	provenance: StackProvenance;
	/** Report a stack that branches, not just a chain. */
	fanOut: boolean;
}

/** What a provider's proposals facet can do. */
export interface ProposalCapabilities {
	/** Fetch the change's commits into a local repo. */
	fetchAsRef: boolean;
	/** Report CI state for a change. */
	checks: boolean;
	/** List changes matching a filter. */
	list: boolean;
}

/**
 * When a backend will accept reviewers on a change.
 *
 * Three states rather than a boolean, because one backend takes them
 * only as the change is created. A caller told "not supported" would
 * never learn about the one moment it is.
 */
export type ReviewersAt = "creation" | "any-time" | "never";

/**
 * What retargeting a change's base means here.
 *
 * Not a boolean either. On one backend a base change goes through
 * resubmitting the whole stack, so retargeting one change is not a
 * smaller version of the same operation and a caller that treats it as
 * one will move changes it did not mean to touch.
 */
export type RetargetScope = "change" | "stack" | "never";

/**
 * What a provider's authoring facet can do.
 *
 * Every field here is a difference the CLI survey actually found. The
 * ones that are booleans elsewhere and enums here are the ones where a
 * boolean would have been a lie.
 */
export interface AuthoringCapabilities {
	propose: boolean;
	/** Propose a whole stack in dependency order, in one go. */
	proposeStack: boolean;
	reviewersAt: ReviewersAt;
	retarget: RetargetScope;
	/** Flip an existing change between draft and ready. */
	setDraft: boolean;
	close: boolean;
	reopen: boolean;
	merge: boolean;
	labels: boolean;
	assignees: boolean;
	/**
	 * Ask CI to run again.
	 *
	 * Here rather than beside `checks` on the proposals facet, which
	 * is where it reads more naturally, because this is a write and
	 * that facet is how a change is read. Every write goes through
	 * one gate and one `offerable` check, and a second write path
	 * hanging off the read facet would have to duplicate both or
	 * skip them.
	 *
	 * Reading CI and retriggering it are still different
	 * permissions, so a provider can report checks and decline to
	 * rerun them. What counts as a rerun is the backend's business:
	 * an API call against the change's own runs on one, and on
	 * another a build tool that is simply how that monorepo
	 * triggers CI.
	 */
	rerunChecks: boolean;
	/**
	 * Whether mutating a change ejects it from a merge queue.
	 *
	 * The expensive one. On a queue-backed backend a push, a rebase or a
	 * base change ejects the change and everything speculatively batched
	 * with it, and re-running CI for the rest is measured in hundreds of
	 * jobs. A caller has to be able to ask before it acts.
	 */
	refusesWhileEnqueued: boolean;
}

/** Everything a provider declares about itself, per repo. */
export interface Capabilities {
	proposals?: ProposalCapabilities;
	stacking?: StackingCapabilities;
	conversation?: ConversationCapabilities;
	authoring?: AuthoringCapabilities;
}
