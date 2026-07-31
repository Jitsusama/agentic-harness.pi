/**
 * What a review looks at: repos, hosted changes and the
 * targets a review session can be pointed at.
 *
 * The vocabulary is git's wherever git has a word for the
 * thing. A repo is named by a locator rather than an
 * owner/name pair, because not every backend has owners. A
 * hosted change carries an opaque, provider-scoped id,
 * because the backends disagree on whether that is a
 * number, a UUID, a branch or a range. A review target is
 * deliberately wider than a hosted change: a range of
 * commits or a stack of branches is reviewable whether or
 * not anyone has proposed it anywhere.
 */

import type { Landability } from "./landing.js";
import type { QueueState } from "./queue.js";

/**
 * Where a repo lives. Providers claim locators; the `key`
 * is the stable identity everything else is scoped by.
 */
export interface RepoLocator {
	/** Stable identity, e.g. `github:Shopify/world`. */
	key: string;
	/** Remote URL, when the repo has one. */
	remoteUrl?: string;
	/** Absolute path to a local checkout, when there is one. */
	localPath?: string;
}

/**
 * A change hosted by a provider: a GitHub pull request, a
 * gitstream pull, a GitLab merge request. The `id` is
 * opaque and only meaningful to the provider that minted
 * it; nothing outside the provider may parse it.
 */
export interface ChangeRef {
	/** Id of the provider that owns this change. */
	provider: string;
	/** Repo the change belongs to. */
	repo: RepoLocator;
	/** Provider-scoped identity. Never parsed by consumers. */
	id: string;
	/**
	 * Short human name for this change, in whatever form its
	 * own system uses: `Shopify/world#123` for a GitHub pull
	 * request, and whatever Meteorite or GitLab call theirs.
	 *
	 * Carried on the reference rather than asked of the
	 * provider, because a consumer that reloaded a reference
	 * from disk still has to be able to name it, and should
	 * not need a live provider or a request to do so.
	 */
	label: string;
}

/**
 * What a review session is looking at.
 *
 * `proposal` is a change someone is hosting. `range` is any
 * two endpoints in a repo, which is how an unposted branch
 * gets reviewed. `stack` is an ordered set of refs reviewed
 * as one body of work, whether or not proposals exist for
 * its members.
 */
export type ReviewTarget =
	| { kind: "proposal"; change: ChangeRef }
	| { kind: "range"; repo: RepoLocator; base: string; head: string }
	| { kind: "stack"; repo: RepoLocator; refs: string[] };

/**
 * Where a hosted change stands. Deliberately three values:
 * draft-ness and locked-ness are flags, not states, because
 * the backends disagree about whether they are states and
 * agree that these three are.
 */
export type ChangeState = "open" | "merged" | "closed";

/** Someone who acted. Identity is provider-scoped. */
export interface Actor {
	/** How the provider names them: login, email, or id. */
	id: string;
	/** Display name, when the provider offers one. */
	name?: string;
}

/** A hosted change, read back. */
export interface Proposal {
	ref: ChangeRef;
	title: string;
	body: string;
	state: ChangeState;
	draft: boolean;
	author: Actor;
	/** Ref the change would merge into. */
	base: string;
	/** Ref holding the proposed work. */
	head: string;
	/** Tip commit of `head`, when the provider reports it. */
	headCommit?: string;
	createdAt?: string;
	updatedAt?: string;
	/** Web location for humans. */
	url?: string;
	/**
	 * How big the change is, when the provider says.
	 *
	 * Carried rather than derived because a consumer that only
	 * wants to state the size should not have to fetch and count a
	 * whole diff, and every backend reports this alongside the rest
	 * of the change. Absent means unreported, which is not the same
	 * as zero.
	 */
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	/**
	 * Where the change stands with a merge queue, when the backend
	 * has one and says.
	 *
	 * Carried on the proposal because the authoring gate has to know
	 * before it acts, and a caller cannot be trusted to have asked:
	 * the gate spent a release reading this off an intent nobody set,
	 * which made it unreachable. Absent means the provider has no
	 * queue or did not report one, which is not the same as unqueued.
	 */
	queue?: QueueState;
	/**
	 * Whether it could land, and what is in the way.
	 *
	 * Absent where the backend does not say. That is not the same as clear to
	 * land, and the narration keeps them apart: a change nobody has judged
	 * reads as unreported rather than as ready.
	 */
	landing?: Landability;
	/**
	 * Labels on the change, where the backend has labels.
	 *
	 * An empty array and an absent field are different facts: the first
	 * says the backend has labels and this change has none, the second
	 * says nobody reported any.
	 */
	labels?: string[];
	/** Who it is assigned to, where the backend assigns changes. */
	assignees?: Actor[];
	/**
	 * Anything the provider knows that the neutral model
	 * does not name. Consumers may read it opportunistically;
	 * nothing in the substrate depends on it.
	 */
	extensions?: Record<string, unknown>;
}
