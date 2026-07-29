/**
 * Asking the flattened page questions.
 *
 * The queries here are the ones that cannot be asked any other
 * way: how many of these are there, where are they, which ones
 * are not rendered, what is inside that frame. A CSS selector
 * run in the page answers some of this, but it answers it inside
 * one document and it cannot see into a closed shadow root or
 * across a frame boundary. The index can, because the browser
 * already flattened all of it.
 */

import type { Bounds, IndexedNode } from "./flatten.js";

/** What to look for. */
export interface Query {
	/** Tag name, matched case-insensitively. */
	readonly tag?: string;
	/** An attribute that must be present, and optionally its value. */
	readonly attribute?: string;
	readonly value?: string;
	/** Text the node must contain, matched case-insensitively. */
	readonly text?: string;
	/** Restrict to a class. */
	readonly className?: string;
	/** Only what the browser rendered, or only what it did not. */
	readonly rendered?: boolean;
	/** Only nodes inside a shadow root. */
	readonly inShadow?: boolean;
	/** Only nodes belonging to this document url. */
	readonly documentUrl?: string;
	/** Only nodes the browser considers clickable. */
	readonly clickable?: boolean;
}

/** Whether one node answers the query. */
export function matches(node: IndexedNode, query: Query): boolean {
	if (query.tag && node.nodeName.toLowerCase() !== query.tag.toLowerCase()) {
		return false;
	}
	if (query.attribute !== undefined) {
		const held = node.attributes[query.attribute];
		if (held === undefined) return false;
		if (query.value !== undefined && held !== query.value) return false;
	} else if (query.value !== undefined) {
		// A value with no attribute to hold it. This used to fall
		// through every predicate and return the whole document,
		// rendered as a real total with the first page of nodes under
		// it: an authoritative-looking answer to a filter that was
		// never applied, which is the worst way for a read tool to
		// fail. Match any attribute carrying the value instead.
		const anywhere = Object.values(node.attributes).includes(query.value);
		if (!anywhere) return false;
	}
	if (query.className !== undefined) {
		const classes = (node.attributes.class ?? "").split(/\s+/);
		if (!classes.includes(query.className)) return false;
	}
	if (query.text !== undefined) {
		const has = (node.text ?? "")
			.toLowerCase()
			.includes(query.text.toLowerCase());
		if (!has) return false;
	}
	if (query.rendered !== undefined && node.rendered !== query.rendered) {
		return false;
	}
	if (query.inShadow !== undefined && node.inShadow !== query.inShadow) {
		return false;
	}
	if (query.clickable !== undefined && node.clickable !== query.clickable) {
		return false;
	}
	if (
		query.documentUrl !== undefined &&
		node.documentUrl !== query.documentUrl
	) {
		return false;
	}
	return true;
}

/** Everything that answers the query, in document order. */
export function find(
	nodes: readonly IndexedNode[],
	query: Query,
): readonly IndexedNode[] {
	return nodes.filter((node) => matches(node, query));
}

/** A tally of something, largest first. */
export interface Tally {
	readonly key: string;
	readonly count: number;
}

/**
 * Count nodes by some property of them.
 *
 * A page with four hundred divs is not usefully listed, but it
 * is usefully counted, and the counting is what tells you the
 * listing would be a waste.
 */
export function tally(
	nodes: readonly IndexedNode[],
	by: (node: IndexedNode) => string | undefined,
): readonly Tally[] {
	const counts = new Map<string, number>();
	for (const node of nodes) {
		const key = by(node);
		if (key === undefined) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([key, count]) => ({ key, count }))
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * How a node reads in a listing.
 *
 * The position says which space it is measured in. A snapshot
 * measures down the document, while an element inspection reports
 * the box model, which measures from the viewport. The same element
 * on a scrolled page reads differently in each, and saying so is
 * what stops the two being compared as though they agreed.
 */
export function describeNode(node: IndexedNode): string {
	const tag = node.nodeName.toLowerCase();
	const id = node.attributes.id ? `#${node.attributes.id}` : "";
	const classes = node.attributes.class
		? `.${node.attributes.class.trim().split(/\s+/).join(".")}`
		: "";
	const where = node.bounds ? ` at ${place(node.bounds)} on the page` : "";
	const notes = [
		node.rendered ? "" : "not rendered",
		node.inShadow ? "in shadow" : "",
		node.clickable ? "clickable" : "",
	].filter(Boolean);
	const tail = notes.length > 0 ? ` (${notes.join(", ")})` : "";
	const words = node.text ? ` "${clip(node.text)}"` : "";
	return `${tag}${id}${classes}${where}${tail}${words}`;
}

/**
 * Say what a node's named properties compute to.
 *
 * A property the snapshot carries no value for is named rather than
 * dropped. Leaving it out would read exactly like a property nobody
 * asked about, and a caller would take the silence for a value.
 */
export function describeStyles(
	node: IndexedNode,
	wanted: readonly string[],
): string {
	return wanted
		.map((property) => {
			const value = node.styles[property];
			// An empty string is what the snapshot gives for a property
			// the browser did not answer, so it is the same absence.
			return `${property}: ${value ? value : "not reported"}`;
		})
		.join("; ");
}

/** How much of a text run is worth showing in a listing. */
const MAX_TEXT = 40;

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}...` : flat;
}

function place(bounds: Bounds): string {
	return (
		`${Math.round(bounds.x)},${Math.round(bounds.y)} ` +
		`${Math.round(bounds.width)}x${Math.round(bounds.height)}`
	);
}
