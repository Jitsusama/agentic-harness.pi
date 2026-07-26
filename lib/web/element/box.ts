/**
 * Where an element is and how big it is.
 *
 * A capture reports each box as a quad: four corners running
 * clockwise from the top left. That survives rotation, which a
 * rectangle cannot, so the conversion here keeps the extent
 * rather than pretending a transformed element is axis-aligned.
 */

/** An axis-aligned box. */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Four corners, clockwise from the top left. */
export type Quad = readonly number[];

/** A box model as the capture reported it. */
export interface RawBoxModel {
	readonly content: Quad;
	readonly padding: Quad;
	readonly border: Quad;
	readonly margin: Quad;
	readonly width: number;
	readonly height: number;
}

/** The four boxes of an element. */
export interface BoxModel {
	readonly content: Rect;
	readonly padding: Rect;
	readonly border: Rect;
	readonly margin: Rect;
	readonly width: number;
	readonly height: number;
}

/** Read a capture's quads as boxes. */
export function normalizeBoxModel(raw: RawBoxModel): BoxModel {
	return {
		content: rectOf(raw.content),
		padding: rectOf(raw.padding),
		border: rectOf(raw.border),
		margin: rectOf(raw.margin),
		width: raw.width,
		height: raw.height,
	};
}

/**
 * The extent of a quad.
 *
 * For an untransformed element this is the quad itself. For a
 * rotated one it is the area the element covers, which is what
 * a question about position and size is really asking.
 */
function rectOf(quad: Quad): Rect {
	const xs = quad.filter((_, index) => index % 2 === 0);
	const ys = quad.filter((_, index) => index % 2 === 1);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The middle of a box. */
export function centreOf(rect: Rect): {
	readonly x: number;
	readonly y: number;
} {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The four corners of a box, pulled inside its edge.
 *
 * A hit test exactly on a boundary can land on the neighbour,
 * so the points sit just inside. A box too small to inset
 * collapses to its centre rather than turning inside out.
 */
export function cornersOf(
	rect: Rect,
	inset = 1,
): readonly { readonly x: number; readonly y: number }[] {
	const dx = Math.min(inset, rect.width / 2);
	const dy = Math.min(inset, rect.height / 2);
	const left = rect.x + dx;
	const right = rect.x + rect.width - dx;
	const top = rect.y + dy;
	const bottom = rect.y + rect.height - dy;
	return [
		{ x: left, y: top },
		{ x: right, y: top },
		{ x: right, y: bottom },
		{ x: left, y: bottom },
	];
}
