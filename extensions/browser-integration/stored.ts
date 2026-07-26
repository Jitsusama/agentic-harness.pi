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

import {
	cite,
	openSessionStore,
	type ResultStore,
} from "../../lib/result/index.js";
import { withinLineBudget } from "../../lib/result/view.js";
import {
	type AxNode,
	type BudgetedOutline,
	withinOutlineBudget,
} from "../../lib/web/a11y/index.js";
import type { Observation } from "../../lib/web/session.js";

/**
 * What a rendered listing spends before the rest is stored.
 *
 * Between the two page budgets: a listing is usually asked for
 * deliberately, like a page read, but its rows are uniform enough
 * that the first screenful tells the caller whether they are
 * looking at the right thing.
 */
const LISTING_BUDGET_BYTES = 8_192;

let store: ResultStore | undefined;

/**
 * This session's store, opened once.
 *
 * The extension owns the lifetime; the library only knows which
 * directory the session gets. An instance holds nothing but that
 * directory, so caching it is about avoiding a repeated mkdir
 * rather than about shared state.
 */
function sessionStore(): ResultStore {
	const opened = store ?? openSessionStore();
	store = opened;
	return opened;
}

/** Drop the cached store, so a new session opens its own. */
export function forgetStore(): void {
	store = undefined;
}

/** A node as a caller queries it: their vocabulary, not the protocol's. */
interface StoredNode {
	readonly role: string;
	readonly name: string;
	readonly value?: string | number;
	readonly description?: string;
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
 * arithmetic the caller cannot check.
 */
export function pageAnswer(observed: Observation, budget: number): string {
	const bounded = withinOutlineBudget(observed.outline, budget);
	const view = heading(observed, bounded);
	if (bounded.elided === undefined) return view;

	const cited = cite(sessionStore(), {
		payload: storedPage(observed),
		view: `${view}\n\n${bounded.elided}`,
		shown: bounded.shown,
		total: bounded.total,
		unit: "outline lines",
	});
	return cited.text;
}

/** Where you are, then what is there. */
function heading(observed: Observation, bounded: BudgetedOutline): string {
	return `${observed.title}\n${observed.url}\n\n${bounded.text}`;
}

/**
 * A rendered listing, bounded for reading and stored for querying.
 *
 * Telemetry renderers lay out every record they are given, which
 * is right of them: a renderer that silently dropped rows would be
 * lying in a different way. Bounding belongs here, where the
 * records are still to hand and can be stored.
 *
 * The counts are lines, matching the page view, because lines are
 * what the reader can see and count for themselves. How many
 * records those lines covered is not knowable from the text, and a
 * citation nobody can check is a citation nobody should trust.
 */
export function listAnswer<T>(args: {
	view: string;
	records: readonly T[];
	unit: string;
	narrowing: string;
	budget?: number;
}): string {
	const budget = args.budget ?? LISTING_BUDGET_BYTES;
	const bounded = withinLineBudget(args.view, budget);
	if (bounded.cut === 0) return bounded.text;

	const cited = cite(sessionStore(), {
		payload: args.records,
		view:
			`${bounded.text}\n\n` +
			`Cut ${bounded.cut.toLocaleString()} of ` +
			`${bounded.total.toLocaleString()} lines to fit the ` +
			`${budget.toLocaleString()} byte budget. ${args.narrowing}`,
		shown: bounded.shown,
		total: bounded.total,
		unit: "lines",
	});
	// The records are what the handle holds, so name them where the
	// caller will write the expression.
	return cited.handle === undefined
		? cited.text
		: `${cited.text}\nThe payload is the ${args.records.length.toLocaleString()} ${args.unit} themselves, not these lines.`;
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
	return {
		role: node.role,
		name: node.name,
		...(node.value === undefined ? {} : { value: node.value }),
		...(node.description === undefined
			? {}
			: { description: node.description }),
		...(node.children.length === 0
			? {}
			: { children: node.children.map(asStoredNode) }),
	};
}
