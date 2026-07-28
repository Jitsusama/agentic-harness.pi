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
import {
	type CookieRecord,
	renderStorage,
	type StorageSnapshot,
} from "../../lib/web/environment/index.js";
import type { Inspection, Observation } from "../../lib/web/session.js";

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

/** One thing the page kept, as a caller would query it. */
interface StoredEntry {
	readonly key: string;
	readonly value: string;
}

/** Everything the page kept, with nothing shortened. */
interface StoredStorage {
	readonly local: readonly StoredEntry[];
	readonly session: readonly StoredEntry[];
	readonly cookies: readonly CookieRecord[];
	readonly clipboard?: string;
	readonly unavailable?: Readonly<Record<string, string>>;
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

/**
 * A response body, bounded for reading and kept whole for asking.
 *
 * Counted in bytes rather than lines, unlike everything else here.
 * A body is content, not a rendering of records, and a minified
 * one is a single line as long as the file: whole-lines-only would
 * either return all of it or none.
 */
export function bodyAnswer(url: string, body: string, budget: number): string {
	const cited = cite(openSessionStore(), {
		payload: body,
		view: `Body of ${url}:\n${body.slice(0, budget)}`,
		shown: budget,
		total: body.length,
		unit: "bytes",
	});
	// A body is one string, so the handle is all or nothing and the
	// citation says so. This family is one of the few that has a
	// third answer, and a reader who wants a whole minified
	// stylesheet wants it in a file rather than in the transcript.
	if (cited.handle === undefined) return cited.text;
	return (
		`${cited.text} Or ask again with 'har' to write every body ` +
		"to an archive on disk."
	);
}

/**
 * What the page has kept, bounded for reading and kept whole.
 *
 * The view previews a long value and says how many characters it
 * held, which on a real page meant a megabyte of cached modules
 * summarized as its first two hundred characters. Announcing a
 * cut is not the same as surviving one, and storage has no
 * argument that fetches a single key, so there was no second
 * call that could have returned the rest.
 *
 * Counted in characters because that is what the view cuts. The
 * entries are all listed however long they are; it is only their
 * values that shorten.
 */
export function storageAnswer(snapshot: StorageSnapshot): string {
	const view = renderStorage(snapshot);
	const payload = storedStorage(snapshot);
	const total = storedCharacters(payload);
	return cite(openSessionStore(), {
		payload,
		view,
		shown: Math.min(view.length, total),
		total,
		unit: "characters of stored values",
	}).text;
}

/** Key and value as fields, so a query can name them. */
function storedStorage(snapshot: StorageSnapshot): StoredStorage {
	const entries = (pairs: readonly (readonly [string, string])[] | undefined) =>
		(pairs ?? []).map(([key, value]) => ({ key, value }));
	return {
		local: entries(snapshot.local),
		session: entries(snapshot.session),
		cookies: snapshot.cookies ?? [],
		...(snapshot.clipboard === undefined
			? {}
			: { clipboard: snapshot.clipboard }),
		...(snapshot.unavailable === undefined
			? {}
			: { unavailable: snapshot.unavailable }),
	};
}

/** How much value text the page is holding, all told. */
function storedCharacters(stored: StoredStorage): number {
	const sum = (entries: readonly { readonly value: string }[]) =>
		entries.reduce((total, entry) => total + entry.value.length, 0);
	return (
		sum(stored.local) +
		sum(stored.session) +
		sum(stored.cookies) +
		(stored.clipboard?.length ?? 0)
	);
}

/** A rendered listing, bounded, with its records kept. */
export function listAnswer<T>(args: {
	view: string;
	/** Lines the caller needs whatever the budget does: see Listing. */
	trailer?: string;
	/** Whether the view leaves records out on its own: see Listing. */
	elided?: boolean;
	records: readonly T[];
	unit: string;
	narrowing: string;
	budget?: number;
}): string {
	return citeListing(openSessionStore(), args);
}

/**
 * How many lines of one element's report to show before storing.
 *
 * An inspection of a trivial element is a dozen lines. One that
 * asks for every curated style, a cascade trace, delegated
 * listeners and four pseudo-state variants runs to hundreds, and
 * the interesting line is as likely to be at the end as the
 * start.
 */
const ELEMENT_LINES = 120;

/**
 * One element's report, bounded for reading and kept for asking.
 *
 * This was the last read in the family that could answer with an
 * unbounded payload and cite nothing. Every other branch either
 * fits in its own view or hands back a handle; this one grew
 * section by section until it was the largest answer here and
 * still the only one a caller could not query.
 */
export function elementAnswer(inspection: Inspection, view: string): string {
	const lines = view.split("\n");
	if (lines.length <= ELEMENT_LINES) return view;

	const cited = cite(openSessionStore(), {
		payload: inspection,
		view: lines.slice(0, ELEMENT_LINES).join("\n"),
		shown: ELEMENT_LINES,
		total: lines.length,
		unit: "report lines",
	});
	return cited.text;
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
