/**
 * Scoping the accessibility tree before it is read.
 *
 * A whole tree is the wrong answer to most questions. A caller
 * asking "how is this page laid out" wants landmarks, not every
 * span inside them; a caller asking "what can I press" wants
 * controls. Scoping narrows the tree first, so the view that
 * gets rendered is the view that was asked for.
 */

import { type AxNode, isMeaningful } from "./tree.js";

/** A reduced view of the page, keeping one kind of thing. */
export type Skeleton = "landmarks" | "headings" | "interactive";

/** How much of the tree to keep. */
export interface TreeScope {
	/** Levels of the outline to keep, counted as the outline reads. */
	readonly depth?: number;
	/** Keep only one kind of element, with the rest folded away. */
	readonly only?: Skeleton;
}

/** The regions that carve a page into its major parts. */
const LANDMARK_ROLES = new Set([
	"banner",
	"complementary",
	"contentinfo",
	"form",
	"main",
	"navigation",
	"region",
	"search",
]);

/** The roles a caller can operate. */
const INTERACTIVE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"link",
	"listbox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem",
]);

/** Whether a node belongs to the skeleton being asked for. */
function keeps(node: AxNode, only: Skeleton): boolean {
	if (only === "landmarks") return LANDMARK_ROLES.has(node.role);
	if (only === "headings") return node.role === "heading";
	return INTERACTIVE_ROLES.has(node.role);
}

/** Narrow a tree to the view the caller asked for. */
export function scopeTree(root: AxNode, scope: TreeScope): AxNode {
	let tree = root;
	if (scope.only) tree = keepOnly(tree, scope.only);
	if (scope.depth !== undefined) tree = cutToDepth(tree, scope.depth);
	return tree;
}

/**
 * Keep the nodes of one kind, folding the rest away. A kept
 * node stays under a kept ancestor, so a navigation inside a
 * banner still reads as nested.
 */
function keepOnly(root: AxNode, only: Skeleton): AxNode {
	const prune = (node: AxNode): AxNode[] => {
		const children = node.children.flatMap(prune);
		if (!keeps(node, only)) return children;
		return [{ ...node, children }];
	};
	return { ...root, children: root.children.flatMap(prune) };
}

/**
 * Cut the tree to a number of levels, counting the way the
 * outline reads: a node that renders as a line costs a level,
 * and a wrapper that folds away costs nothing.
 */
function cutToDepth(root: AxNode, depth: number): AxNode {
	const cut = (node: AxNode, remaining: number): AxNode[] => {
		const shown = isMeaningful(node);
		const left = shown ? remaining - 1 : remaining;
		if (shown && remaining <= 0) return [];
		const children = left > 0 ? node.children.flatMap((c) => cut(c, left)) : [];
		return [{ ...node, children }];
	};
	return { ...root, children: root.children.flatMap((c) => cut(c, depth)) };
}

/** The branch rooted at the element carrying this backend id. */
export function subtreeAt(
	root: AxNode,
	backendDomId: number,
): AxNode | undefined {
	if (root.backendDomId === backendDomId) return root;
	for (const child of root.children) {
		const found = subtreeAt(child, backendDomId);
		if (found) return found;
	}
	return undefined;
}
