/**
 * Comparing two screenshots.
 *
 * The comparison itself is pixelmatch, which already handles the
 * thing that makes naive diffing useless: antialiasing. Two
 * renders of identical markup differ along every curved edge,
 * and a tool that reports those has told you nothing while
 * looking thorough.
 *
 * What is added here is the refusal to compare images of
 * different sizes. Padding or cropping one to fit would produce
 * a number, and the number would be a lie: everything below the
 * join would read as changed. A page that got taller is a real
 * result and deserves saying so.
 */

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
	attributeRegions,
	type Comparison,
	clusterRegions,
	type Placed,
} from "./regions.js";

/**
 * How different a pixel must be to count.
 *
 * pixelmatch's own scale, where zero matches exactly. This is a
 * presentational choice: it decides what counts as a change, not
 * what one is.
 */
export const MATCH_THRESHOLD = 0.1;

/** Read a PNG from bytes. */
export function readPng(bytes: Buffer): PNG {
	return PNG.sync.read(bytes);
}

/** What a diff produced, including the image of itself. */
export interface DiffResult {
	readonly comparison: Comparison;
	/** The diff image, when there was anything to draw. */
	readonly image?: Buffer;
}

/**
 * Compare two images and locate what changed.
 *
 * The diff image is only produced when something differs, since
 * writing an empty overlay to disk for an unchanged page is a
 * file somebody has to open to learn nothing.
 */
export function compareImages(
	baseline: PNG,
	current: PNG,
	elements: readonly Placed[] = [],
	options: {
		readonly threshold?: number;
		readonly cell?: number;
		readonly scale?: number;
	} = {},
): DiffResult {
	if (baseline.width !== current.width || baseline.height !== current.height) {
		return {
			comparison: {
				kind: "incomparable",
				because:
					`the baseline is ${baseline.width} by ${baseline.height} and ` +
					`this one is ${current.width} by ${current.height}. A page ` +
					"that changed size is a result in itself, so neither was " +
					"cropped to fit.",
			},
		};
	}

	const { width, height } = baseline;
	const diff = new PNG({ width, height });
	const changedPixels = pixelmatch(
		baseline.data,
		current.data,
		diff.data,
		width,
		height,
		{ threshold: options.threshold ?? MATCH_THRESHOLD },
	);

	if (changedPixels === 0) {
		return {
			comparison: {
				kind: "compared",
				width,
				height,
				changedPixels: 0,
				fraction: 0,
				regions: [],
			},
		};
	}

	// pixelmatch paints differing pixels red into the diff image,
	// so the mask is read back out of what it drew rather than
	// diffing a second time.
	const changed = new Uint8Array(width * height);
	for (let index = 0; index < changed.length; index += 1) {
		const at = index * 4;
		changed[index] =
			diff.data[at] === 255 && (diff.data[at + 1] ?? 0) < 128 ? 1 : 0;
	}

	// A screenshot taken at device pixel ratio two is twice the
	// size of the layout the elements were measured in, so region
	// coordinates are brought back to CSS pixels before anything
	// is attributed to an element.
	const scale = options.scale ?? 1;
	const regions = clusterRegions(changed, width, height, {
		...(options.cell === undefined ? {} : { cell: options.cell }),
	}).map((region) =>
		scale === 1
			? region
			: {
					...region,
					x: Math.round(region.x / scale),
					y: Math.round(region.y / scale),
					width: Math.round(region.width / scale),
					height: Math.round(region.height / scale),
				},
	);

	return {
		comparison: {
			kind: "compared",
			width,
			height,
			changedPixels,
			fraction: changedPixels / (width * height),
			regions: attributeRegions(regions, elements),
		},
		image: PNG.sync.write(diff),
	};
}
