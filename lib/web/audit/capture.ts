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
	/** Absent when the tree did not say, which it does not for
	 * any node it ignored. Not the same as false. */
	readonly focusable?: boolean;
}

/** Roles the browser reports for things nobody can see. */
const INVISIBLE_ROLES = new Set(["none", "presentation", "InlineTextBox"]);

/** Elements the browser lets focus land on without being told. */
const FOCUSABLE_TAGS = new Set([
	"BUTTON",
	"INPUT",
	"SELECT",
	"TEXTAREA",
	"SUMMARY",
]);

/**
 * Whether the markup makes this focusable.
 *
 * Used when the accessibility tree declines to say, which it
 * does for every node it ignored, including everything inside an
 * aria-hidden subtree. That is precisely the case the
 * hidden-but-focusable rule is about, so without this the rule
 * has no way to see its own subject.
 */
function focusableByMarkup(node: IndexedNode): boolean {
	const tabindex = node.attributes.tabindex;
	if (tabindex !== undefined) return Number(tabindex) > -1;
	if (node.attributes.disabled !== undefined) return false;
	if (node.nodeName === "A") return node.attributes.href !== undefined;
	return FOCUSABLE_TAGS.has(node.nodeName);
}

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

	/**
	 * Whether anything from here up has been made inert.
	 *
	 * inert takes a subtree out of the focus order without changing
	 * how any of it looks, so no style or markup question about the
	 * element itself can see it. A closed dialog is the ordinary
	 * case, and its contents are usually aria-hidden too, which is
	 * exactly the pair that made this matter: on one real page 45
	 * controls inside two closed dialogs were reported as critical
	 * WCAG failures for being aria-hidden and focusable, when none
	 * of the 45 could take focus at all.
	 */
	const inertHere = (node: IndexedNode): boolean => {
		if (node.attributes.inert !== undefined) return true;
		for (const id of ancestorsOf(node)) {
			if (byId.get(id)?.attributes.inert !== undefined) return true;
		}
		return false;
	};

	/**
	 * Whether focus could actually land here, for a node the
	 * accessibility tree declined to describe.
	 *
	 * Markup says an input is focusable. It cannot say that this one
	 * was never laid out, sits under visibility:hidden, or belongs
	 * to an inert subtree, and each of those settles the question
	 * the other way. Measured on one real page, 48 controls met the
	 * markup test inside aria-hidden subtrees and exactly none of
	 * them could take focus: 42 hidden by visibility, 3 by display,
	 * 3 inert. Reported as they were, that is 48 critical WCAG
	 * failures on a page with none.
	 *
	 * visibility is asked of the element rather than its ancestors
	 * because it inherits, so the computed value already carries
	 * the answer, including a child that opts back in with
	 * visibility:visible.
	 */
	const couldTakeFocus = (node: IndexedNode): boolean => {
		if (!node.rendered) return false;
		const visibility = node.styles.visibility;
		if (visibility === "hidden" || visibility === "collapse") return false;
		return !inertHere(node);
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
				// The accessibility tree only reports focusable on nodes
				// it did not ignore, and an aria-hidden subtree is exactly
				// what it ignores: measured against a live page, every
				// ignored node arrives with an empty property list. So
				// asking the tree whether a hidden thing can take focus
				// always answered no, and the rule built on that question
				// could never fire. Fall back to the markup, which is
				// where focusability comes from in the first place.
				//
				// The fallback has to carry its own weight, though: see
				// couldTakeFocus, which is what stops a page's closed
				// dialogs arriving as a wall of critical failures.
				focusable:
					fact?.focusable ?? (focusableByMarkup(node) && couldTakeFocus(node)),
				rendered: node.rendered,
				ancestors: ancestorsOf(node),
				html: openingTag(node),
			};
		});
}
