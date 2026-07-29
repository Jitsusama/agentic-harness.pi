/**
 * The stack this workflow shows, and the narrowing that gets
 * there from the topology a provider reports.
 *
 * The walking itself moved to the provider, which knows how to
 * ask its own backend and whether the parentage it hands back was
 * recorded or inferred. What is left here is the shape this
 * workflow's views speak and the projection onto it.
 *
 * That projection is lossy on purpose. Refs nobody has proposed
 * are dropped, since entries are named by pull request. The tree
 * is linearized along the cursor's lineage, since a chain cannot
 * hold a fan-out, and the cursor's children are reported beside
 * it instead. A cursor the provider will not place yields nothing
 * at all, because every view here reads as "where you are".
 */

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { StackNode, Stack as Topology } from "../../lib/review/index.js";
import { githubViewOf } from "./reference.js";

/** A PR participating in a stack. */
export interface StackEntry {
	readonly reference: PRReference;
	readonly title: string;
	readonly baseRefName: string;
	readonly headRefName: string;
}

/** A discovered stack with cursor position. */
export interface Stack {
	/** PRs ordered parent → child, cursor included. */
	readonly entries: StackEntry[];
	/** Index into `entries` for the cursor PR. */
	readonly cursorIndex: number;
	/**
	 * Direct children of the cursor when downstream branches.
	 * Empty when the cursor has zero or exactly one child;
	 * populated when there is a fan-out.
	 */
	readonly cursorChildren: StackEntry[];
}

/**
 * The substrate's topology as the stack this workflow shows.
 *
 * Three narrowings happen here, and each one is a decision:
 *
 * A ref nobody has proposed is dropped. The substrate reports it
 * because a stack of unproposed branches is still a stack, but
 * this view names its entries by pull request and has nothing to
 * call one.
 *
 * The tree is linearized along the cursor's own lineage. A stack
 * that fans out has no single chain, and picking a branch would
 * assert a parentage nobody stated, so the cursor's children are
 * reported beside the chain instead of inside it.
 *
 * An unplaced cursor yields nothing. Every view here reads as
 * "where you are in this stack", and there is no honest answer to
 * that when the provider will not say.
 */
export function stackViewFrom(topology: Topology): Stack {
	const empty: Stack = { entries: [], cursorIndex: -1, cursorChildren: [] };
	const cursor =
		topology.cursor === undefined ? undefined : topology.nodes[topology.cursor];
	if (!cursor) return empty;

	const byRef = new Map(topology.nodes.map((n) => [n.ref, n]));
	// One set spans both directions. A provider that reports two
	// refs parented on each other would otherwise be walked twice,
	// once going up and once coming back down, and land the same
	// change in the chain more than once.
	const seen = new Set<string>([cursor.ref]);
	const lineage = [...ancestorsOf(cursor, byRef, seen), cursor];
	const children = childrenOf(cursor.ref, topology.nodes);
	// One child continues the chain. Two is a fan-out, which the
	// chain cannot express, so it is set aside rather than resolved.
	const chain =
		children.length === 1
			? [...lineage, ...descendantsOf(children[0], topology.nodes, seen)]
			: lineage;

	const entries = chain.map(entryOf).filter(isEntry);
	const cursorEntry = entryOf(cursor);
	return {
		entries,
		// Found by identity rather than by counting, since dropping
		// unproposed refs moves everything after them.
		cursorIndex: cursorEntry
			? entries.findIndex(
					(e) => e.reference.number === cursorEntry.reference.number,
				)
			: -1,
		cursorChildren:
			children.length > 1 ? children.map(entryOf).filter(isEntry) : [],
	};
}

/** Every node between the trunk and this one, trunk first. */
function ancestorsOf(
	node: StackNode,
	byRef: ReadonlyMap<string, StackNode>,
	seen: Set<string>,
): StackNode[] {
	const line: StackNode[] = [];
	let parent = node.parent ? byRef.get(node.parent) : undefined;
	while (parent && !seen.has(parent.ref)) {
		seen.add(parent.ref);
		line.unshift(parent);
		parent = parent.parent ? byRef.get(parent.parent) : undefined;
	}
	return line;
}

/** A node's direct children, in the order the provider gave them. */
function childrenOf(
	ref: string,
	nodes: readonly StackNode[],
): readonly StackNode[] {
	return nodes.filter((n) => n.parent === ref);
}

/** A node and its single-child descent, stopping at any fan-out. */
function descendantsOf(
	from: StackNode,
	nodes: readonly StackNode[],
	seen: Set<string>,
): StackNode[] {
	const line: StackNode[] = [];
	let node: StackNode | undefined = from;
	while (node && !seen.has(node.ref)) {
		seen.add(node.ref);
		line.push(node);
		const children = childrenOf(node.ref, nodes);
		node = children.length === 1 ? children[0] : undefined;
	}
	return line;
}

/** A node as an entry, or nothing when no proposal names it. */
function entryOf(node: StackNode): StackEntry | null {
	const proposal = node.proposal;
	if (!proposal) return null;
	const reference = githubViewOf(proposal.ref);
	if (!reference) return null;
	return {
		reference,
		title: proposal.title,
		baseRefName: proposal.base,
		headRefName: proposal.head,
	};
}

function isEntry(entry: StackEntry | null): entry is StackEntry {
	return entry !== null;
}
