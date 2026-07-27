/**
 * The browser family's half of the store-and-cite bargain.
 *
 * A page read used to hand back however much outline the page
 * happened to render. On an ordinary application that is a few
 * kilobytes; on one source file of eighteen thousand lines it was
 * two and a half megabytes, and a wheel scroll returned all of it
 * because every action answers with the page it left behind.
 *
 * Now the view is bounded and the tree is kept. What the caller
 * reads is as much outline as the budget affords; what they can
 * still reach is every node, by query. The two are the same
 * capture, so narrowing never means reading a page that has since
 * moved.
 */

import { cite, citeListing, openSessionStore } from "../../lib/result/index.js";
import {
	type AxNode,
	type BudgetedOutline,
	describeStates,
	withinOutlineBudget,
} from "../../lib/web/a11y/index.js";
import type { Observation } from "../../lib/web/session.js";

/** A node as a caller queries it: their vocabulary, not the protocol's. */
interface StoredNode {
	readonly role: string;
	readonly name: string;
	readonly value?: string | number;
	readonly description?: string;
	/** The states the outline reports, in the outline's own words. */
	readonly states?: readonly string[];
	readonly children?: readonly StoredNode[];
}

/** What a page read stores: where it was, and everything on it. */
interface StoredPage {
	readonly url: string;
	readonly title: string;
	readonly nodes: readonly StoredNode[];
}

/**
 * A page read, bounded for reading and stored for querying.
 *
 * The counts in the citation are outline lines rather than nodes,
 * because lines are what the view is measured in and a citation
 * that counted one thing while the view showed another would be
 * arithmetic the caller cannot check. What the payload holds is
 * named alongside, since a caller writing their first expression
 * against lines when the payload holds a node tree gets nothing
 * back and no clue why. The listings learned this from driving
 * Slack; this path was written before that and never got it.
 */
export function pageAnswer(observed: Observation, budget: number): string {
	const bounded = withinOutlineBudget(observed.outline, budget);
	const view = heading(observed, bounded);
	if (bounded.elided === undefined) return view;

	const payload = storedPage(observed);
	const cited = cite(openSessionStore(), {
		payload,
		view: `${view}\n\n${bounded.elided}`,
		shown: bounded.shown,
		total: bounded.total,
		unit: "outline lines",
		stored: { count: countNodes(payload.nodes), unit: "nodes" },
	});
	return cited.text;
}

/** Where you are, then what is there. */
function heading(observed: Observation, bounded: BudgetedOutline): string {
	return `${observed.title}\n${observed.url}\n\n${bounded.text}`;
}

/** A rendered listing, bounded, with its records kept. */
export function listAnswer<T>(args: {
	view: string;
	records: readonly T[];
	unit: string;
	narrowing: string;
	budget?: number;
}): string {
	return citeListing(openSessionStore(), args);
}

/** The tree as a payload: named fields, no protocol ids. */
function storedPage(observed: Observation): StoredPage {
	return {
		url: observed.url,
		title: observed.title,
		nodes: observed.tree.children.map(asStoredNode),
	};
}

function asStoredNode(node: AxNode): StoredNode {
	// The same states the outline prints, in the same words. The
	// payload used to carry role, name and children only, so a page
	// stored for querying was lossier than the page shown for
	// reading: the outline said "checked" and "required" on a line
	// the caller could see, and the query that went looking for them
	// returned nothing.
	const states = describeStates(node);
	return {
		role: node.role,
		name: node.name,
		...(node.value === undefined ? {} : { value: node.value }),
		...(node.description === undefined
			? {}
			: { description: node.description }),
		...(states.length === 0 ? {} : { states }),
		...(node.children.length === 0
			? {}
			: { children: node.children.map(asStoredNode) }),
	};
}

/** How many nodes a stored tree holds, itself included. */
function countNodes(nodes: readonly StoredNode[]): number {
	return nodes.reduce(
		(total, node) => total + 1 + countNodes(node.children ?? []),
		0,
	);
}
