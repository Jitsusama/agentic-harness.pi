/**
 * Rendering the accessibility tree as an outline.
 *
 * The outline is the model's default view of a page: a nested
 * role-and-name listing that reads like a description, with the
 * states that change what a caller can do shown inline. It is
 * the surface act refusals, audits and page reads all quote.
 */

import { describeStates } from "./states.js";
import { type AxNode, isMeaningful } from "./tree.js";

/**
 * Render the tree as a nested role-and-name outline, with the
 * states that change what a caller can do shown inline. A node
 * that is not meaningful (a noise role with no name) is folded
 * away: its children rise to its own indentation, so wrappers
 * never add depth while their named descendants survive.
 *
 * A node that has no name is written as its role alone. Structure
 * is most of a real page, a third of the nodes in a long article
 * carry no name at all, and empty quotes against every one of
 * them cost more than a whole action-view budget while telling a
 * reader nothing they did not already have from the role.
 */
export function renderAxOutline(root: AxNode): string {
	const lines: string[] = [];
	const walk = (node: AxNode, depth: number): void => {
		const shown = isMeaningful(node);
		if (shown) {
			const states = describeStates(node);
			const suffix = states.length ? ` ${states.join(" ")}` : "";
			const named = node.name ? ` "${node.name}"` : "";
			lines.push(`${"  ".repeat(depth)}${node.role}${named}${suffix}`);
		}
		const childDepth = shown ? depth + 1 : depth;
		for (const child of node.children) walk(child, childDepth);
	};
	// The root itself is the page container; render its children.
	for (const child of root.children) walk(child, 0);
	return lines.join("\n");
}
