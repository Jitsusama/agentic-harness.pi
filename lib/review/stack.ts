/**
 * A stack: refs pointing at refs.
 *
 * Topology comes first and proposals decorate it, which is
 * the inverse of deriving a stack from a list of pull
 * requests. The inversion matters because a stack of
 * branches nobody has proposed yet is still a stack, and
 * because the one backend that projects stacks server-side
 * hands back topology whether or not every node has a
 * proposal on it.
 *
 * Every stack says where its shape came from. One backend
 * knows the answer, one has to guess from base and head
 * names, and a bare repo reads it out of local config. A
 * consumer that cannot tell those apart will present a
 * guess as fact.
 */

import type { Proposal } from "./change.js";

/**
 * Where a stack's shape came from. `authoritative` means the
 * backend recorded the parentage; `derived` means it was
 * inferred and may be wrong at the edges.
 */
export type StackProvenance = "authoritative" | "derived";

/** One ref in a stack. */
export interface StackNode {
	/** The ref this node is, e.g. `refs/heads/topic`. */
	ref: string;
	/** The ref it sits on, absent for the root. */
	parent?: string;
	/** Tip commit of `ref`, when known. */
	headCommit?: string;
	/**
	 * Commit where this node left its parent, when known.
	 * Every local stacking tool surveyed records this, since
	 * it is what makes a restack possible after a rebase.
	 */
	forkPoint?: string;
	/** The proposal on this node, when one exists. */
	proposal?: Proposal;
	/**
	 * True when the parent has moved since this node last
	 * agreed with it, where the provider can tell.
	 */
	behindParent?: boolean;
}

/** A stack, rooted at a trunk. */
export interface Stack {
	provenance: StackProvenance;
	/**
	 * The trunk the stack ultimately targets, when known.
	 * Not a node: the trunk is not part of the stack.
	 */
	trunk?: string;
	/**
	 * Nodes in topological order, roots before children. A
	 * stack may fan out, so this is a tree flattened rather
	 * than a chain.
	 */
	nodes: StackNode[];
	/**
	 * Index in `nodes` of the ref the caller is standing on,
	 * when the question has an answer.
	 */
	cursor?: number;
}
