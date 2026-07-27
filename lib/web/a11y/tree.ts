/**
 * The enriched accessibility tree.
 *
 * Chrome's accessibility tree is the page as assistive
 * technology sees it. This normalizes a raw CDP capture into a
 * tree that keeps what a screen reader would announce: not
 * just role and name, but the states, values and levels that
 * say what a control is doing right now.
 *
 * The input is plain serializable data, so a capture from
 * anywhere (CDP, Playwright, a fixture on disk) can be
 * analyzed by the same code.
 */

import { type NameSource, nameSource } from "./naming.js";

/** One way Chrome tried to name an element. */
export interface RawAxNameSource {
	type: string;
	attribute?: string;
	nativeSource?: string;
	value?: { type?: string; value?: string | number };
	/** Chrome found a name here but a higher-priority source won. */
	superseded?: boolean;
	/** The page pointed this source at something that is not there. */
	invalid?: boolean;
}

/** A property Chrome reports against an accessibility node. */
export interface RawAxProperty {
	name: string;
	value?: { type?: string; value?: string | number | boolean };
}

/** A raw CDP accessibility node (the fields we read). */
export interface RawAxNode {
	nodeId: string;
	parentId?: string;
	backendDOMNodeId?: number;
	childIds?: string[];
	role?: { value?: string };
	name?: { value?: string; sources?: RawAxNameSource[] };
	description?: { value?: string };
	value?: { type?: string; value?: string | number };
	properties?: RawAxProperty[];
	ignored?: boolean;
}

/** The states and relationships reported against a node. */
export type AxProperties = Readonly<Record<string, string | number | boolean>>;

/** A normalized accessibility node. */
export interface AxNode {
	readonly role: string;
	readonly name: string;
	/** CDP backend DOM node id, used internally to resolve an element. */
	readonly backendDomId?: number;
	/** The control's current value, when it has one. */
	readonly value?: string | number;
	/** Which mechanism produced the accessible name. */
	readonly nameFrom?: NameSource;
	readonly description?: string;
	readonly properties: AxProperties;
	readonly children: readonly AxNode[];
}

/** An empty tree, for a capture with nothing in it. */
const EMPTY: AxNode = { role: "", name: "", properties: {}, children: [] };

/**
 * Roles whose node carries no meaning of its own: it exists to
 * hold the text its parent is already named after.
 */
const TEXT_CARRIER_ROLES = new Set([
	"StaticText",
	"InlineTextBox",
	"text",
	"LabelText",
]);

/** Roles that exist to draw something, and say nothing. */
const PRESENTATIONAL_ROLES = new Set(["ListMarker"]);

/**
 * Normalize a raw CDP accessibility capture into a tree.
 *
 * A node the page does not expose is folded, not pruned: a real
 * capture buries the whole document under ignored html and body
 * wrappers, so its exposed children rise in its place.
 *
 * A text carrier whose name only repeats a named ancestor is
 * folded away too: the page says "Save" once, so the tree should
 * too. Text that no ancestor is named after is content, and
 * survives.
 */
export function normalizeAxTree(nodes: readonly RawAxNode[]): AxNode {
	const byId = new Map(nodes.map((node) => [node.nodeId, node]));

	const build = (id: string, namedAncestors: readonly string[]): AxNode[] => {
		const rawNode = byId.get(id);
		if (!rawNode) return [];

		const role = rawNode.role?.value ?? "";
		const name = rawNode.name?.value ?? "";
		// An unexposed node is a wrapper as far as we are
		// concerned: it contributes nothing itself, but what it
		// contains may still be part of the page.
		if (rawNode.ignored) {
			return (rawNode.childIds ?? []).flatMap((childId) =>
				build(childId, namedAncestors),
			);
		}
		// A carrier repeating a name an ancestor already announced
		// is a duplicate; its children repeat it too, so the whole
		// branch goes.
		if (TEXT_CARRIER_ROLES.has(role) && namedAncestors.includes(name)) {
			return [];
		}
		// A line box is one rendered line of the text above it, so it
		// repeats a fragment rather than the whole and never matches
		// exactly. Containment is the test that catches it, and it is
		// applied only to this role: a short StaticText can sit inside
		// a longer name legitimately, whereas a line box never carries
		// anything its parent's text does not already contain.
		//
		// When no ancestor announced the words, the line box is the
		// only copy there is, which happens once its StaticText parent
		// is ignored and its children rise. Then it stays.
		if (
			role === "InlineTextBox" &&
			namedAncestors.some((announced) => announced.includes(name))
		) {
			return [];
		}

		if (PRESENTATIONAL_ROLES.has(role)) return [];

		const value = rawNode.value?.value;
		// The value is shown against the control itself, so text
		// beneath it saying the same thing is a second copy.
		const spoken = [...namedAncestors, ...(name ? [name] : [])];
		const inherited = value === undefined ? spoken : [...spoken, String(value)];
		const children = dropRepeatedText(
			(rawNode.childIds ?? []).flatMap((childId) => build(childId, inherited)),
		);

		const backend = rawNode.backendDOMNodeId;
		const description = rawNode.description?.value;
		// Only say where a name came from when the capture
		// actually reported the mechanisms it tried.
		const from = rawNode.name?.sources ? nameSource(rawNode) : undefined;
		return [
			{
				role,
				name,
				...(backend !== undefined ? { backendDomId: backend } : {}),
				...(value !== undefined ? { value } : {}),
				...(from ? { nameFrom: from } : {}),
				...(description ? { description } : {}),
				properties: readProperties(rawNode),
				children,
			},
		];
	};

	const root = nodes.find((node) => !node.parentId) ?? nodes[0];
	if (!root) return EMPTY;
	return build(root.nodeId, [])[0] ?? EMPTY;
}

/**
 * Drop text among a set of siblings that another sibling has
 * already announced. A label sits beside the control it names,
 * so its text reaches the caller through the control and does
 * not need a line of its own.
 */
function dropRepeatedText(siblings: readonly AxNode[]): AxNode[] {
	const spokenElsewhere = new Set(
		siblings
			.filter((node) => !isTextOnly(node))
			.map((node) => node.name)
			.filter((name) => name.length > 0),
	);
	if (spokenElsewhere.size === 0) return [...siblings];
	return siblings.filter(
		(node) => !(isTextOnly(node) && spokenElsewhere.has(carriedText(node))),
	);
}

/** Whether a node is nothing but the text it carries. */
function isTextOnly(node: AxNode): boolean {
	if (!TEXT_CARRIER_ROLES.has(node.role)) return false;
	return node.children.every(isTextOnly);
}

/**
 * The text a carrier presents. A label holds its words in a
 * child rather than its own name, so read through to them.
 */
function carriedText(node: AxNode): string {
	if (node.name) return node.name;
	return node.children.map(carriedText).join("").trim();
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

/**
 * Whether a node says anything on its own. An unnamed wrapper
 * does not: it is scaffolding the page needed and the reader
 * does not. Rendering folds these away, and scoping does not
 * count them as a level, so the two agree on what a level is.
 */
export function isMeaningful(node: AxNode): boolean {
	if (node.name.trim().length > 0) return true;
	return !NOISE_ROLES.has(node.role);
}

/** Collect a node's reported properties into a flat record. */
function readProperties(node: RawAxNode): AxProperties {
	const properties: Record<string, string | number | boolean> = {};
	for (const property of node.properties ?? []) {
		const value = property.value?.value;
		if (value !== undefined) properties[property.name] = value;
	}
	return properties;
}

/** One frame's accessibility tree, and the element that holds it. */
export interface FrameAxTree {
	/** Backend DOM node id of the iframe element that owns the frame. */
	readonly ownerBackendNodeId: number;
	readonly nodes: readonly RawAxNode[];
}

/**
 * Hang each frame's tree under the iframe element that owns it.
 *
 * Chrome answers for one frame at a time: the page's tree stops
 * at an Iframe node with no children, and the frame's own tree
 * arrives separately, rooted at its own RootWebArea. Left
 * unjoined, every reading of the page ended at the boundary, and
 * an outline, a structural audit or a keyboard walk simply did
 * not contain what the frame held. Nothing said so, which is the
 * worst part: an embedded checkout form read as an empty box.
 *
 * Every frame's nodes are renumbered on the way in. Both trees
 * number from one, so merging them as they arrive makes the
 * frame's root a duplicate of the page's, and a walk over the
 * result either loses nodes or goes round forever.
 *
 * Frames whose owner is not present are dropped rather than
 * attached to the root. That covers a cross-origin frame, which
 * cannot be read at all, and a frame that went away while we were
 * asking; inventing a parent for either would put content
 * somewhere the page does not have it.
 */
export function spliceFrames(
	main: readonly RawAxNode[],
	frames: readonly FrameAxTree[],
): RawAxNode[] {
	if (frames.length === 0) return [...main];

	const merged: RawAxNode[] = main.map((node) => ({ ...node }));
	const byBackendId = new Map<number, RawAxNode>();
	for (const node of merged) {
		if (node.backendDOMNodeId !== undefined) {
			byBackendId.set(node.backendDOMNodeId, node);
		}
	}

	// In order, so a frame nested inside another is spliced after
	// its parent frame has been merged and its owner is findable.
	frames.forEach((frame, index) => {
		const owner = byBackendId.get(frame.ownerBackendNodeId);
		if (!owner) return;

		const prefix = `f${index}:`;
		const rename = (id: string): string => `${prefix}${id}`;
		const renamed = frame.nodes.map((node) => ({
			...node,
			nodeId: rename(node.nodeId),
			...(node.parentId === undefined
				? {}
				: { parentId: rename(node.parentId) }),
			...(node.childIds === undefined
				? {}
				: { childIds: node.childIds.map(rename) }),
		}));

		const root = renamed.find((node) => node.parentId === undefined);
		if (!root) return;
		root.parentId = owner.nodeId;
		owner.childIds = [...(owner.childIds ?? []), root.nodeId];

		for (const node of renamed) {
			merged.push(node);
			if (node.backendDOMNodeId !== undefined) {
				byBackendId.set(node.backendDOMNodeId, node);
			}
		}
	});

	return merged;
}
