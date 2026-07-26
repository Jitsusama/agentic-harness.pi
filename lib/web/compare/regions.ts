/**
 * Turning a field of changed pixels into places that changed.
 *
 * A pixel count is nearly useless on its own. Two hundred
 * thousand differing pixels might be the whole page shifted by
 * one row, or one image swapped, and those need opposite
 * responses. What a person wants is where, and how many
 * separate wheres there are.
 *
 * Regions are built on a coarse grid rather than by exact
 * connected pixels, deliberately. Pixel-exact blobs split a
 * single moved paragraph into one region per glyph; a grid of a
 * few pixels joins them into the thing that actually moved.
 */

/** A changed area of the image, in pixels. */
export interface Region {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** How many pixels inside it actually differ. */
	readonly pixels: number;
}

/** How wide a grid cell is when grouping changes. */
export const CELL_SIZE = 8;

/** Regions smaller than this are noise, not a change. */
export const MIN_REGION_PIXELS = 4;

/**
 * Group changed pixels into rectangles.
 *
 * `changed` is one entry per pixel, row-major, truthy where the
 * two images differ. That shape is what an image diff produces
 * and costs nothing to build from one.
 */
export function clusterRegions(
	changed: ArrayLike<number> | readonly boolean[],
	width: number,
	height: number,
	options: { readonly cell?: number; readonly minPixels?: number } = {},
): readonly Region[] {
	const cell = options.cell ?? CELL_SIZE;
	const minPixels = options.minPixels ?? MIN_REGION_PIXELS;
	if (width <= 0 || height <= 0) return [];

	const across = Math.ceil(width / cell);
	const down = Math.ceil(height / cell);
	// One count per cell, so a region knows how much of it moved,
	// and the true extent of the changed pixels inside it. The
	// grid decides what groups together; it must not decide the
	// bounds, or a region snapped out to cell edges stops fitting
	// inside the element it belongs to and gets blamed on the body.
	const counts = new Int32Array(across * down);
	const leftOf = new Int32Array(across * down).fill(width);
	const topOf = new Int32Array(across * down).fill(height);
	const rightOf = new Int32Array(across * down).fill(-1);
	const bottomOf = new Int32Array(across * down).fill(-1);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!changed[y * width + x]) continue;
			const at = Math.floor(y / cell) * across + Math.floor(x / cell);
			counts[at] += 1;
			if (x < (leftOf[at] ?? width)) leftOf[at] = x;
			if (y < (topOf[at] ?? height)) topOf[at] = y;
			if (x > (rightOf[at] ?? -1)) rightOf[at] = x;
			if (y > (bottomOf[at] ?? -1)) bottomOf[at] = y;
		}
	}

	const seen = new Uint8Array(across * down);
	const regions: Region[] = [];

	for (let index = 0; index < counts.length; index += 1) {
		if (seen[index] || (counts[index] ?? 0) === 0) continue;

		// Flood fill across touching cells, diagonals included, so a
		// change running at an angle stays one region.
		const stack = [index];
		seen[index] = 1;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let pixels = 0;

		while (stack.length > 0) {
			const at = stack.pop();
			if (at === undefined) continue;
			const cellX = at % across;
			const cellY = Math.floor(at / across);
			pixels += counts[at] ?? 0;
			minX = Math.min(minX, leftOf[at] ?? width);
			minY = Math.min(minY, topOf[at] ?? height);
			maxX = Math.max(maxX, rightOf[at] ?? -1);
			maxY = Math.max(maxY, bottomOf[at] ?? -1);

			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					const nx = cellX + dx;
					const ny = cellY + dy;
					if (nx < 0 || ny < 0 || nx >= across || ny >= down) continue;
					const next = ny * across + nx;
					if (seen[next] || (counts[next] ?? 0) === 0) continue;
					seen[next] = 1;
					stack.push(next);
				}
			}
		}

		if (pixels < minPixels) continue;
		regions.push({
			x: minX,
			y: minY,
			width: maxX - minX + 1,
			height: maxY - minY + 1,
			pixels,
		});
	}

	// Biggest change first: it is the one most likely to matter.
	return regions.sort((a, b) => b.pixels - a.pixels);
}

/** An element, for saying what a changed region sits on. */
export interface Placed {
	readonly selector: string;
	readonly rect: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

/** A region with the element it most likely belongs to. */
export interface AttributedRegion extends Region {
	readonly selector?: string;
}

/**
 * Whether an element covers a changed region.
 *
 * The element's box is rounded outward to the pixels it can
 * paint into before comparing. A rect is fractional and a
 * region is whole pixels, so an element starting at y=442.5
 * paints row 442, and comparing the two raw numbers rejected it
 * by half a pixel. Every change then fell through to the body,
 * which is an answer that helps nobody.
 */
function contains(outer: Placed["rect"], region: Region): boolean {
	return (
		region.x >= Math.floor(outer.x) &&
		region.y >= Math.floor(outer.y) &&
		region.x + region.width <= Math.ceil(outer.x + outer.width) &&
		region.y + region.height <= Math.ceil(outer.y + outer.height)
	);
}

function area(rect: Placed["rect"]): number {
	return rect.width * rect.height;
}

/**
 * Say what each changed region sits on.
 *
 * The smallest element that fully contains the region wins,
 * since every region is inside the body and saying so helps
 * nobody. A region spanning two elements is left unattributed
 * rather than blamed on their common ancestor: "something under
 * main changed" is not an answer.
 */
export function attributeRegions(
	regions: readonly Region[],
	elements: readonly Placed[],
): readonly AttributedRegion[] {
	return regions.map((region) => {
		let best: Placed | undefined;
		for (const element of elements) {
			if (!contains(element.rect, region)) continue;
			if (best === undefined || area(element.rect) < area(best.rect)) {
				best = element;
			}
		}
		return best === undefined ? region : { ...region, selector: best.selector };
	});
}

/** What a comparison concluded. */
export type Comparison =
	| {
			readonly kind: "compared";
			readonly width: number;
			readonly height: number;
			readonly changedPixels: number;
			readonly fraction: number;
			readonly regions: readonly AttributedRegion[];
	  }
	| {
			readonly kind: "incomparable";
			readonly because: string;
	  };

/** Below this share of the image, a change is worth ignoring. */
export const IGNORABLE_FRACTION = 0.0001;

/** How many regions to name before counting the rest. */
const MAX_NAMED_REGIONS = 8;

/** Say what changed, and where. */
export function renderComparison(
	comparison: Comparison,
	artifacts: readonly string[] = [],
): string {
	if (comparison.kind === "incomparable") {
		return `The two images cannot be compared: ${comparison.because}`;
	}

	const { changedPixels, fraction, regions, width, height } = comparison;
	if (changedPixels === 0) {
		return `Identical. Both are ${width} by ${height}.`;
	}

	const percent = (fraction * 100).toFixed(fraction < 0.001 ? 4 : 2);
	const lines = [
		`${changedPixels} pixels differ, ${percent} percent of the image, ` +
			`across ${regions.length} ${
				regions.length === 1 ? "region" : "separate regions"
			}.`,
	];
	if (fraction < IGNORABLE_FRACTION) {
		lines.push(
			"That is small enough to be rendering noise rather than a change.",
		);
	}
	lines.push("");

	for (const region of regions.slice(0, MAX_NAMED_REGIONS)) {
		const where = region.selector ? `  ${region.selector}` : "";
		lines.push(
			`  ${region.width} by ${region.height} at ` +
				`(${region.x}, ${region.y}), ${region.pixels} pixels${where}`,
		);
	}
	if (regions.length > MAX_NAMED_REGIONS) {
		lines.push(`  ... and ${regions.length - MAX_NAMED_REGIONS} more regions`);
	}

	if (artifacts.length > 0) {
		lines.push("", ...artifacts);
	}
	return lines.join("\n");
}
