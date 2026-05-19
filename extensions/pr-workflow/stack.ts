/**
 * PR stack discovery.
 *
 * Walks up and down the base/head branch chain starting from
 * a cursor PR to find the stack it belongs to. The walker is
 * pure: it consumes a `PrSearch` which production wires up to
 * GitHub GraphQL and tests wire up to an in-memory list.
 *
 * The walker only follows linear chains. Upstream walks pick
 * the single PR whose head matches the cursor's base, and
 * stop at the first non-match. Downstream walks pick the
 * single PR whose base matches the cursor's head, and stop
 * if there are zero or multiple matches. Fan-out children at
 * the cursor itself are reported separately so the agent can
 * still talk about them.
 *
 * The walker is defensive against cycles: an entry whose PR
 * number has already been visited terminates that direction.
 */

import type { PRReference } from "../../lib/internal/github/pr-reference.js";

/** A PR participating in a stack. */
export interface StackEntry {
	readonly reference: PRReference;
	readonly title: string;
	readonly baseRefName: string;
	readonly headRefName: string;
}

/** Search interface the walker depends on. */
export interface PrSearch {
	/** Find one open PR whose head branch is `branch`, or null. */
	findByHead(branch: string): Promise<StackEntry | null>;
	/** Find every open PR whose base branch is `branch`. */
	findByBase(branch: string): Promise<StackEntry[]>;
}

/** Options for `buildStack`. */
export interface BuildStackOptions {
	/** Maximum entries to walk in each direction. Default: 8. */
	maxDepth?: number;
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

const DEFAULT_MAX_DEPTH = 8;

/**
 * Walk parents (upstream) and children (downstream) of
 * `cursor` to construct an ordered stack with the cursor
 * positioned inside it.
 */
export async function buildStack(
	cursor: StackEntry,
	search: PrSearch,
	options: BuildStackOptions = {},
): Promise<Stack> {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const seen = new Set<number>([cursor.reference.number]);

	const upstream: StackEntry[] = [];
	let upBranch = cursor.baseRefName;
	for (let i = 0; i < maxDepth; i++) {
		const parent = await search.findByHead(upBranch);
		if (parent === null) break;
		if (seen.has(parent.reference.number)) break;
		seen.add(parent.reference.number);
		upstream.push(parent);
		upBranch = parent.baseRefName;
	}
	upstream.reverse(); // walker collects child → parent; reverse to parent → child.

	const cursorChildrenRaw = await search.findByBase(cursor.headRefName);
	const cursorChildren = cursorChildrenRaw.filter(
		(c) => !seen.has(c.reference.number),
	);
	for (const c of cursorChildren) {
		seen.add(c.reference.number);
	}

	const downstream: StackEntry[] = [];
	if (cursorChildren.length === 1) {
		// Linear chain downstream; keep walking.
		let next: StackEntry | undefined = cursorChildren[0];
		downstream.push(next);
		for (let i = 1; i < maxDepth; i++) {
			const children = await search.findByBase(next.headRefName);
			const fresh = children.filter((c) => !seen.has(c.reference.number));
			if (fresh.length !== 1) break;
			next = fresh[0];
			seen.add(next.reference.number);
			downstream.push(next);
		}
	}

	const entries = [...upstream, cursor, ...downstream];
	return {
		entries,
		cursorIndex: upstream.length,
		cursorChildren: cursorChildren.length > 1 ? cursorChildren : [],
	};
}
