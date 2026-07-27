/**
 * Semantic targeting: resolve the way the model addresses an
 * element (role plus accessible name, disambiguated by
 * container or a name-scoped ordinal) to the matched node's
 * internal backend id. The id never reaches the model; the
 * caller uses it to drive the real element, and falls back to
 * text, selector or coordinates when the tree cannot name the
 * element.
 */

import type { AxNode } from "../a11y/index.js";

/** How the model addresses an element. */
export interface Target {
	readonly role: string;
	/**
	 * The accessible name, when there is one. An icon button or a
	 * bare input has none, and the outline shows only its role, so
	 * a role on its own has to be a way of addressing it.
	 */
	readonly name?: string;
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

/**
 * How this module compares a written role or name to the one
 * in the tree: case and surrounding whitespace never decide a
 * match. Shared with the refusal ladder so both agree on what
 * counts as the same name.
 */
export function foldEquals(
	a: string | undefined,
	b: string | undefined,
): boolean {
	// A missing name and an empty one are the same thing here:
	// parseTarget already yields "" for a bare role, and a node
	// with nothing to call it normalizes the same way. Accepting
	// undefined keeps a caller outside TypeScript from getting a
	// TypeError three frames down instead of an answer.
	return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Every node under (and including) root, depth-first. */
function flatten(node: AxNode, into: AxNode[]): void {
	into.push(node);
	for (const child of node.children) flatten(child, into);
}

/** The subtrees whose container matches, or the whole tree when none is asked for. */
function scopes(root: AxNode, container: Target["container"]): AxNode[] {
	if (!container) return [root];
	const all: AxNode[] = [];
	flatten(root, all);
	return all.filter(
		(node) =>
			foldEquals(node.name, container.name) &&
			(container.role === undefined || foldEquals(node.role, container.role)),
	);
}

/**
 * Resolve a semantic target to a backend id, or report that it
 * matched nothing or more than one node.
 */
export function resolveTarget(root: AxNode, target: Target): TargetResolution {
	const matches: AxNode[] = [];
	for (const scope of scopes(root, target.container)) {
		const nodes: AxNode[] = [];
		flatten(scope, nodes);
		for (const node of nodes) {
			if (
				foldEquals(node.role, target.role) &&
				foldEquals(node.name, target.name)
			) {
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

/**
 * Read a target written the way the outline prints it.
 *
 * The role is the first word, since roles are single words and
 * names routinely are not. Quotes around the name are allowed,
 * because a caller copying from the outline will bring them.
 * A bare role targets the unnamed element of that role, which
 * is how landmarks usually appear.
 */
export function parseTarget(spec: string): Target | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;
	const split = trimmed.indexOf(" ");
	if (split < 0) return { role: trimmed, name: "" };
	return {
		role: trimmed.slice(0, split),
		name: unquote(trimmed.slice(split + 1).trim()),
	};
}

/** Drop a matched pair of surrounding quotes. */
function unquote(name: string): string {
	return name.replace(/^(["'])(.*)\1$/, "$2");
}
