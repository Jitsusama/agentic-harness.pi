/**
 * Semantic targeting: resolve the way the model addresses an
 * element (role plus accessible name, disambiguated by
 * container or a name-scoped ordinal) to the matched node's
 * internal backend id. The id never reaches the model; the
 * caller uses it to drive the real element, and falls back to
 * text, selector or coordinates when the tree cannot name the
 * element.
 */

import type { AxNode } from "./a11y.js";

/** How the model addresses an element. */
export interface SemanticTarget {
	readonly role: string;
	readonly name: string;
	/** Restrict to descendants of a container with this name (and optional role). */
	readonly container?: { readonly role?: string; readonly name: string };
	/** 1-based position among same-named matches ("the second X"). */
	readonly ordinal?: number;
}

/** The outcome of resolving a target. */
export type TargetResolution =
	| { kind: "resolved"; backendDomId: number }
	| { kind: "ambiguous"; count: number }
	| { kind: "notFound" };

function eq(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Every node under (and including) root, depth-first. */
function flatten(node: AxNode, into: AxNode[]): void {
	into.push(node);
	for (const child of node.children) flatten(child, into);
}

/** The subtrees whose container matches, or the whole tree when none is asked for. */
function scopes(
	root: AxNode,
	container: SemanticTarget["container"],
): AxNode[] {
	if (!container) return [root];
	const all: AxNode[] = [];
	flatten(root, all);
	return all.filter(
		(node) =>
			eq(node.name, container.name) &&
			(container.role === undefined || eq(node.role, container.role)),
	);
}

/**
 * Resolve a semantic target to a backend id, or report that it
 * matched nothing or more than one node.
 */
export function resolveTarget(
	root: AxNode,
	target: SemanticTarget,
): TargetResolution {
	const matches: AxNode[] = [];
	for (const scope of scopes(root, target.container)) {
		const nodes: AxNode[] = [];
		flatten(scope, nodes);
		for (const node of nodes) {
			if (eq(node.role, target.role) && eq(node.name, target.name)) {
				matches.push(node);
			}
		}
	}

	if (target.ordinal !== undefined) {
		const picked = matches[target.ordinal - 1];
		return picked?.backendDomId !== undefined
			? { kind: "resolved", backendDomId: picked.backendDomId }
			: { kind: "notFound" };
	}
	if (matches.length === 0) return { kind: "notFound" };
	if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
	const only = matches[0];
	return only.backendDomId !== undefined
		? { kind: "resolved", backendDomId: only.backendDomId }
		: { kind: "notFound" };
}
