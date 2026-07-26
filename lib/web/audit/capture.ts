/**
 * Building the structural view from two of the browser's own
 * accounts of the page.
 *
 * The snapshot knows every element, its attributes, whether it
 * was drawn and where it sits in the tree. The accessibility
 * tree knows what each one is and what it is called. Neither
 * knows both, and every structural rule needs both, so they are
 * joined here on the backend node id that appears in each.
 *
 * The join is the whole of this module's job. No role is
 * inferred from a tag, no name is derived from content, and
 * nothing is guessed when a node appears in one account and not
 * the other. What the browser did not say, this does not say.
 */

import type { IndexedNode } from "../snapshot/index.js";
import type { StructureNode } from "./structure.js";

/** The accessibility facts a structural rule needs. */
export interface AxFacts {
	readonly backendNodeId: number;
	readonly role?: string;
	readonly name?: string;
	readonly focusable: boolean;
}

/** Roles the browser reports for things nobody can see. */
const INVISIBLE_ROLES = new Set(["none", "presentation", "InlineTextBox"]);

/**
 * Give an element an address a person can act on.
 *
 * An id is best, then a test hook, then a class, and a tag with
 * its position as the last resort. This is presentation, not
 * measurement: the browser did not offer a selector, and one
 * that reads well is worth more than one that is unique.
 */
export function selectorFor(node: IndexedNode): string {
	const tag = node.nodeName.toLowerCase();
	const { id, class: className } = node.attributes;
	if (id) return `#${id}`;
	const hook =
		node.attributes["data-testid"] ?? node.attributes["data-test-id"];
	if (hook) return `${tag}[data-testid="${hook}"]`;
	if (className) {
		const first = className.trim().split(/\s+/)[0];
		if (first) return `${tag}.${first}`;
	}
	return tag;
}

/** How much markup to keep against a finding. */
const MAX_HTML = 160;

/**
 * Rebuild an element's opening tag from its attributes.
 *
 * The snapshot does not carry outerHTML, and fetching it per
 * node would be a protocol round trip each. The opening tag is
 * what a person needs to recognise the element anyway.
 */
function openingTag(node: IndexedNode): string {
	const tag = node.nodeName.toLowerCase();
	const attributes = Object.entries(node.attributes)
		.map(([name, value]) => (value === "" ? name : `${name}="${value}"`))
		.join(" ");
	const rendered = attributes === "" ? `<${tag}>` : `<${tag} ${attributes}>`;
	return rendered.length <= MAX_HTML
		? rendered
		: `${rendered.slice(0, MAX_HTML)}...`;
}

/**
 * Join a snapshot to an accessibility tree.
 *
 * Text nodes are dropped: every structural rule is about
 * elements, and keeping the text would double the size of the
 * capture to no purpose.
 */
export function buildStructure(
	nodes: readonly IndexedNode[],
	facts: readonly AxFacts[],
): readonly StructureNode[] {
	const byBackendId = new Map(facts.map((fact) => [fact.backendNodeId, fact]));
	const byId = new Map(nodes.map((node) => [node.id, node]));

	const ancestorsOf = (node: IndexedNode): string[] => {
		const chain: string[] = [];
		let current = node.parent;
		while (current !== undefined) {
			chain.push(current);
			current = byId.get(current)?.parent;
		}
		return chain;
	};

	return nodes
		.filter((node) => node.nodeName !== "#text" && node.nodeName !== "#comment")
		.map((node) => {
			const fact = byBackendId.get(node.backendNodeId);
			const role =
				fact?.role && !INVISIBLE_ROLES.has(fact.role) ? fact.role : undefined;
			return {
				id: node.id,
				selector: selectorFor(node),
				tag: node.nodeName.toLowerCase(),
				attributes: node.attributes,
				...(role === undefined ? {} : { role }),
				...(fact?.name === undefined || fact.name === ""
					? {}
					: { name: fact.name }),
				focusable: fact?.focusable ?? false,
				rendered: node.rendered,
				ancestors: ancestorsOf(node),
				html: openingTag(node),
			};
		});
}
