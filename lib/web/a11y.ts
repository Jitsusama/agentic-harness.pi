/**
 * Accessibility outline and semantic targeting.
 *
 * The model addresses the page the way it already thinks:
 * role plus accessible name. This renders the accessibility
 * tree as a nested role-and-name outline that reads like a
 * description, dropping structurally noisy nodes so the
 * outline is not a wall of wrappers. Opaque node ids never
 * appear; targeting resolves a semantic target back to a
 * node internally (see target.ts).
 */

/** A normalized accessibility node (from CDP getFullAXTree). */
export interface AxNode {
	readonly role: string;
	readonly name: string;
	/** CDP backend DOM node id, used internally to resolve an element. */
	readonly backendDomId?: number;
	readonly children: readonly AxNode[];
}

/** Roles that add no meaning on their own and are folded away when unnamed. */
const NOISE_ROLES = new Set([
	"generic",
	"none",
	"presentation",
	"document",
	"RootWebArea",
	"InlineTextBox",
	"StaticText",
	"text",
]);

/** Whether a node earns its own line in the outline. */
function isMeaningful(node: AxNode): boolean {
	if (node.name.trim().length > 0) return true;
	return !NOISE_ROLES.has(node.role);
}

/**
 * Render the tree as a nested role-and-name outline. A node
 * that is not meaningful (a noise role with no name) is folded
 * away: its children rise to its own indentation, so wrappers
 * never add depth while their named descendants survive.
 */
export function renderAxOutline(root: AxNode): string {
	const lines: string[] = [];
	const walk = (node: AxNode, depth: number): void => {
		const shown = isMeaningful(node);
		if (shown) {
			lines.push(`${"  ".repeat(depth)}${node.role} "${node.name}"`);
		}
		const childDepth = shown ? depth + 1 : depth;
		for (const child of node.children) walk(child, childDepth);
	};
	// The root itself is the page container; render its children.
	for (const child of root.children) walk(child, 0);
	return lines.join("\n");
}
