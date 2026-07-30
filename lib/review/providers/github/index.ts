/**
 * The GitHub provider.
 *
 * Reaches GitHub through the `gh` CLI, which is where the
 * authentication already lives. Capabilities are declared from
 * what GitHub actually does rather than what would be
 * convenient: it flags a stranded anchor instead of pinning
 * one, it cannot thread a reply onto a top-level comment, and
 * it records no stack at all, so any stack it reports is
 * derived and says so.
 */

import type { Capabilities } from "../../capabilities.js";
import type { Reaction } from "../../conversation.js";
import type { ReviewProvider } from "../../provider.js";
import type { ProviderDeps } from "../exec.js";
import { githubAuthoring } from "./authoring.js";
import {
	claimGitHubReference,
	claimGitHubRepo,
	GITHUB_PROVIDER_ID,
} from "./claims.js";
import { githubConversation } from "./conversation.js";
import { githubProposals } from "./proposals.js";
import { githubStacking } from "./stacking.js";

/**
 * Claim priority. A generalist: any backend that specializes
 * in a repo GitHub also mirrors should be asked first.
 */
const GITHUB_PRIORITY = 100;

/** The reactions GitHub accepts, in its own order. */
const GITHUB_REACTIONS: readonly Reaction[] = [
	"+1",
	"-1",
	"laugh",
	"confused",
	"heart",
	"hooray",
	"rocket",
	"eyes",
];

/** What GitHub can do, which does not vary by repo. */
function githubCapabilities(): Capabilities {
	return {
		proposals: { fetchAsRef: true, checks: true, list: true },
		stacking: { provenance: "derived", fanOut: true },
		conversation: {
			anchoredBatchReview: true,
			fileLevelComments: true,
			multiLineRanges: true,
			suggestions: true,
			unresolve: true,
			reactions: GITHUB_REACTIONS,
			// A reply must target a review thread; issue comments
			// have no thread to hang from.
			topLevelThreading: false,
			pendingReviews: true,
			// A force-push strands a thread and GitHub marks it,
			// rather than keeping the anchor's commit reachable.
			staleness: "flagged",
			selfVerdicts: ["comment"],
		},
		authoring: {
			propose: true,
			// One change at a time. GitHub has no notion of a stack, so
			// there is nothing to submit as one.
			proposeStack: false,
			reviewersAt: "any-time",
			// A base is a field on the change here, so retargeting one
			// change moves that change and nothing else.
			retarget: "change",
			setDraft: true,
			close: true,
			reopen: true,
			merge: true,
			labels: true,
			assignees: true,
			autoMerge: true,
			deleteBranchOnMerge: true,
			// This said false, on the belief that a merge queue was
			// something a backend layered on top of GitHub added. GitHub
			// has its own: `MergeQueueEntry` is on the GraphQL pull
			// request, it reports a position and whether the change is
			// being tested `solo`, and pushing to a queued change ejects
			// it the same way. Saying false here made the queue gate dead
			// on GitHub as well as unreachable everywhere.
			//
			// Declaring true is not the same as refusing: the proposals
			// facet reports the posture, and a change with no queue entry
			// reads as unqueued and is permitted. The gate bites only when
			// there is really something to eject.
			refusesWhileEnqueued: true,
		},
	};
}

/** Build the GitHub provider. */
export function createGitHubProvider(deps: ProviderDeps): ReviewProvider {
	return {
		id: GITHUB_PROVIDER_ID,
		priority: GITHUB_PRIORITY,
		claimReference: claimGitHubReference,
		claimRepo: claimGitHubRepo,
		capabilities: githubCapabilities,
		proposals: githubProposals(deps.exec),
		conversation: githubConversation(deps.exec),
		stacking: githubStacking(deps.exec),
		authoring: githubAuthoring(deps.exec),
	};
}
