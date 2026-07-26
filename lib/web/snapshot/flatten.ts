/**
 * The whole page, flattened into one addressable list.
 *
 * The protocol hands a snapshot over as a struct of parallel
 * arrays with every string replaced by an index into one shared
 * table, and rare properties held as sparse pairs. That shape is
 * excellent to transmit and impossible to reason about, so this
 * turns it into nodes you can look at.
 *
 * Two things it gets for free, which are otherwise painful.
 * Shadow content is already inline under its host, with no
 * separate root node, and the protocol marks every node of a
 * shadow tree rather than only its root, so piercing needs no
 * traversal at all. And every iframe arrives as another document
 * linked from the node that hosts it, so the whole page, frames
 * included, is one list once they are joined.
 *
 * Whether a node is rendered is not inferred from its styles: it
 * is whether the browser gave it a layout entry, which is the
 * browser's own answer, and the only one that accounts for an
 * ancestor being hidden.
 */

/** Sparse properties: the nodes that have one, and the values. */
export interface RareValues {
	readonly index: readonly number[];
	readonly value?: readonly number[];
}

/** Node arrays, as the protocol packs them. */
export interface RawNodes {
	readonly parentIndex: readonly number[];
	readonly nodeType: readonly number[];
	readonly nodeName: readonly number[];
	readonly nodeValue: readonly number[];
	readonly backendNodeId: readonly number[];
	readonly attributes: readonly (readonly number[])[];
	readonly shadowRootType?: RareValues;
	readonly contentDocumentIndex?: RareValues;
	readonly isClickable?: RareValues;
	readonly pseudoType?: RareValues;
}

/** Layout arrays, covering only the nodes that were rendered. */
export interface RawLayout {
	readonly nodeIndex: readonly number[];
	readonly styles: readonly (readonly number[])[];
	readonly bounds: readonly (readonly number[])[];
	readonly text?: readonly number[];
}

/** One document: the page, or a frame within it. */
export interface RawDocument {
	readonly documentURL: number;
	readonly title?: number;
	readonly nodes: RawNodes;
	readonly layout: RawLayout;
	readonly scrollOffsetX?: number;
	readonly scrollOffsetY?: number;
}

/** DOMSnapshot.captureSnapshot, as it comes back. */
export interface RawSnapshot {
	readonly documents: readonly RawDocument[];
	readonly strings: readonly string[];
}

/** Where something is on the page. */
export interface Bounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** One node, with everything known about it in one place. */
export interface IndexedNode {
	/** Unique across every document in the snapshot. */
	readonly id: string;
	readonly documentIndex: number;
	readonly documentUrl: string;
	readonly nodeName: string;
	readonly nodeType: number;
	readonly backendNodeId: number;
	readonly attributes: Readonly<Record<string, string>>;
	/** The id of the parent, across frame boundaries. */
	readonly parent?: string;
	readonly styles: Readonly<Record<string, string>>;
	readonly bounds?: Bounds;
	readonly text?: string;
	readonly clickable: boolean;
	readonly inShadow: boolean;
	/** Whether the browser laid it out at all. */
	readonly rendered: boolean;
}

/** Node types worth naming, rather than leaving as numbers. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Whether this node is an element. */
export function isElement(node: IndexedNode): boolean {
	return node.nodeType === ELEMENT_NODE;
}

/** Whether this node is a run of text. */
export function isText(node: IndexedNode): boolean {
	return node.nodeType === TEXT_NODE;
}

/** Turn sparse pairs into something you can ask a question of. */
function sparse(rare: RareValues | undefined): Map<number, number> {
	const found = new Map<number, number>();
	if (!rare) return found;
	rare.index.forEach((nodeIndex, at) => {
		// A rare boolean has indices and no values: being listed is
		// the whole message.
		found.set(nodeIndex, rare.value?.[at] ?? 1);
	});
	return found;
}

/**
 * Flatten a snapshot into addressable nodes.
 *
 * The style property names must be given in the same order they
 * were requested in, because the protocol returns the values as
 * a bare array positioned against that request and never names
 * them again.
 */
export function flattenSnapshot(
	snapshot: RawSnapshot,
	styleProperties: readonly string[],
): readonly IndexedNode[] {
	const text = (index: number | undefined): string =>
		index === undefined || index < 0 ? "" : (snapshot.strings[index] ?? "");

	const nodes: IndexedNode[] = [];
	// Which document each iframe host node opens, so a child
	// document can be attached to the node that owns it.
	const hostOfDocument = new Map<number, string>();

	snapshot.documents.forEach((document, documentIndex) => {
		const { nodes: raw, layout } = document;
		const documentUrl = text(document.documentURL);
		const id = (nodeIndex: number) => `${documentIndex}:${nodeIndex}`;

		const shadowRoots = sparse(raw.shadowRootType);
		const clickable = sparse(raw.isClickable);
		const contentDocuments = sparse(raw.contentDocumentIndex);

		// Layout is indexed by its own position, so the mapping from
		// a node back to its layout entry has to be built once.
		const layoutOf = new Map<number, number>();
		layout.nodeIndex.forEach((nodeIndex, at) => {
			layoutOf.set(nodeIndex, at);
		});

		for (const [nodeIndex, nameIndex] of raw.nodeName.entries()) {
			const at = layoutOf.get(nodeIndex);
			const parentIndex = raw.parentIndex[nodeIndex] ?? -1;

			const attributes: Record<string, string> = {};
			const packed = raw.attributes[nodeIndex] ?? [];
			for (let pair = 0; pair + 1 < packed.length; pair += 2) {
				attributes[text(packed[pair])] = text(packed[pair + 1]);
			}

			const styles: Record<string, string> = {};
			if (at !== undefined) {
				const values = layout.styles[at] ?? [];
				styleProperties.forEach((property, position) => {
					const value = text(values[position]);
					if (value !== "") styles[property] = value;
				});
			}

			const box = at === undefined ? undefined : layout.bounds[at];
			const own = text(layout.text?.[at ?? -1]);

			nodes.push({
				id: id(nodeIndex),
				documentIndex,
				documentUrl,
				nodeName: text(nameIndex),
				nodeType: raw.nodeType[nodeIndex] ?? 0,
				backendNodeId: raw.backendNodeId[nodeIndex] ?? 0,
				attributes,
				...(parentIndex >= 0 ? { parent: id(parentIndex) } : {}),
				styles,
				...(box && box.length === 4
					? {
							bounds: {
								x: box[0] as number,
								y: box[1] as number,
								width: box[2] as number,
								height: box[3] as number,
							},
						}
					: {}),
				...(own === "" ? {} : { text: own }),
				clickable: clickable.has(nodeIndex),
				inShadow: shadowRoots.has(nodeIndex),
				rendered: at !== undefined,
			});

			const opens = contentDocuments.get(nodeIndex);
			if (opens !== undefined) hostOfDocument.set(opens, id(nodeIndex));
		}
	});

	// Join the frames on: a frame's root has no parent of its own,
	// so it takes the node that hosts it, and the page becomes one
	// tree rather than several.
	return nodes.map((node) => {
		if (node.parent !== undefined) return node;
		const host = hostOfDocument.get(node.documentIndex);
		return host === undefined ? node : { ...node, parent: host };
	});
}
