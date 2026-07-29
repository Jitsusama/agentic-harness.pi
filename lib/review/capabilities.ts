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

/** What a provider's conversation facet can do. */
export interface ConversationCapabilities {
	/** Post a verdict and anchored comments in one submission. */
	anchoredBatchReview: boolean;
	/** Cap on comments per batch, when there is one. */
	maxBatchComments?: number;
	/** Anchor a remark to a file rather than a line. */
	fileLevelComments: boolean;
	/** Anchor a remark to a run of lines. */
	multiLineRanges: boolean;
	/** Carry a suggested edit a reader can apply. */
	suggestions: boolean;
	/** Reopen a resolved thread. */
	unresolve: boolean;
	/** Reactions the provider accepts. Empty means none. */
	reactions: readonly Reaction[];
	/** Reply onto a top-level message, not just a thread. */
	topLevelThreading: boolean;
	/** Hold a review as a draft before submitting it. */
	pendingReviews: boolean;
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

/** Everything a provider declares about itself, per repo. */
export interface Capabilities {
	proposals?: ProposalCapabilities;
	stacking?: StackingCapabilities;
	conversation?: ConversationCapabilities;
}
