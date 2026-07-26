/**
 * What a page is actually built from, and where it drifted.
 *
 * A design system is a claim about consistency, and a rendered
 * page is the evidence for or against it. Counting distinct
 * values is the easy half. The useful half is noticing that four
 * of the greys differ by one step out of 255, which is not a
 * palette but an accident that happened four times.
 *
 * Nothing here decides whether drift is wrong. Two blues a step
 * apart may be a bug or may be a hover state, and this cannot
 * tell which. It reports the cluster and the evidence; the
 * judgment is a person's.
 */

import { deltaE, type Rgba } from "../audit/colour.js";
import { renderVerdict } from "../audit/verdict.js";

/** One value found on the page, and how often. */
export interface Usage {
	readonly value: string;
	readonly count: number;
	/** A few places it was used, for finding it again. */
	readonly examples: readonly string[];
}

/** Values close enough that they may have been meant as one. */
export interface Cluster {
	/** The most used member, which is the likely intended value. */
	readonly leader: Usage;
	/** The others, ordered by how often they appear. */
	readonly nearby: readonly Usage[];
	/** How many uses the whole cluster accounts for. */
	readonly total: number;
}

/** Everything found for one property. */
export interface Dimension {
	readonly property: string;
	readonly distinct: number;
	readonly usages: readonly Usage[];
	readonly clusters: readonly Cluster[];
}

/** One element's contribution to the inventory. */
export interface StyleSample {
	readonly selector: string;
	readonly values: Readonly<Record<string, string>>;
}

/** How many places to remember per value. */
const MAX_EXAMPLES = 3;

/**
 * Colours closer than this delta E are treated as one intent.
 *
 * Delta E rather than contrast ratio. Contrast compares relative
 * luminance only and is blind to hue, so it called pure red and
 * a mid grey the same colour: their ratio is about 1.001, well
 * inside any sameness threshold. That is the right measure for
 * whether text can be read and the wrong one for whether two
 * values were meant to be one.
 *
 * Around 2 is a just-noticeable difference, so 5 catches the
 * pairs a person would have to look twice at while leaving a
 * deliberate step in a palette alone.
 */
export const COLOUR_SAMENESS = 5;

/**
 * How close two opacities must be to belong to one intent.
 *
 * A solid colour and a half-transparent one are a deliberate
 * pair, and delta E does not see alpha at all.
 */
export const ALPHA_SAMENESS = 0.05;

/**
 * How close two lengths must be to read as one intent.
 *
 * Two thresholds, because one does not work. A purely relative
 * test is too loose at large values and too strict at small
 * ones: it clustered 14px with 16px, which is a deliberate step
 * in any type scale, while leaving 4px and 5px apart, which is
 * exactly the radius drift worth reporting. An absolute
 * tolerance handles the small end and a tight relative one
 * handles the large.
 */
export const LENGTH_SAMENESS = 0.08;
export const LENGTH_TOLERANCE_PX = 1.5;

/** Count every value of every property across the samples. */
export function tallyUsage(
	samples: readonly StyleSample[],
	property: string,
): readonly Usage[] {
	const counts = new Map<string, { count: number; examples: string[] }>();
	for (const sample of samples) {
		const value = sample.values[property];
		if (value === undefined || value === "") continue;
		const entry = counts.get(value) ?? { count: 0, examples: [] };
		entry.count += 1;
		if (entry.examples.length < MAX_EXAMPLES)
			entry.examples.push(sample.selector);
		counts.set(value, entry);
	}
	return [...counts.entries()]
		.map(([value, entry]) => ({
			value,
			count: entry.count,
			examples: entry.examples,
		}))
		.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Whether two values are near enough to be one intent. */
export type Nearness = (one: string, other: string) => boolean;

/**
 * Group values that are nearly the same.
 *
 * Greedy from the most used value outward, which is what makes
 * the leader the likely intended one: a value used forty times
 * with three near neighbours reads as a standard plus three
 * mistakes, not as four equal options.
 */
export function clusterUsage(
	usages: readonly Usage[],
	near: Nearness,
): readonly Cluster[] {
	const remaining = [...usages];
	const clusters: Cluster[] = [];

	while (remaining.length > 0) {
		const leader = remaining.shift();
		if (!leader) break;
		const nearby: Usage[] = [];
		for (let index = remaining.length - 1; index >= 0; index -= 1) {
			const candidate = remaining[index];
			if (!candidate) continue;
			if (!near(leader.value, candidate.value)) continue;
			nearby.unshift(candidate);
			remaining.splice(index, 1);
		}
		if (nearby.length === 0) continue;
		clusters.push({
			leader,
			nearby,
			total: leader.count + nearby.reduce((sum, one) => sum + one.count, 0),
		});
	}
	return clusters;
}

/** Read a colour the browser serialized, for comparison. */
function readColour(css: string): Rgba | undefined {
	const found = /rgba?\(([^)]+)\)/.exec(css);
	if (!found?.[1]) return undefined;
	const parts = found[1]
		.split(/[\s,/]+/)
		.filter(Boolean)
		.map(Number);
	const [r, g, b, a] = parts;
	if (r === undefined || g === undefined || b === undefined) return undefined;
	return { r, g, b, a: a ?? 1 };
}

/** Two colours nobody could tell apart side by side. */
export const coloursAreNear: Nearness = (one, other) => {
	const a = readColour(one);
	const b = readColour(other);
	if (!a || !b) return false;
	// Fully transparent is its own thing, not a near-black.
	if (a.a === 0 || b.a === 0) return a.a === b.a;
	// Two colours at the same opacity, or near enough. A solid and
	// a half-transparent version of one colour are a deliberate
	// pair, not a drift.
	if (Math.abs((a.a ?? 1) - (b.a ?? 1)) > ALPHA_SAMENESS) return false;
	return deltaE(a, b) < COLOUR_SAMENESS;
};

/** Every pixel length in a value, in order. */
function lengths(css: string): readonly number[] {
	return [...css.matchAll(/(-?[\d.]+)px/g)].map((found) => Number(found[1]));
}

/** Two single lengths close enough to have been meant as one. */
function oneLengthIsNear(a: number, b: number): boolean {
	if (a === b) return true;
	// Zero has no neighbours: nothing is nearly nothing.
	if (a === 0 || b === 0) return false;
	const apart = Math.abs(a - b);
	if (apart <= LENGTH_TOLERANCE_PX) return true;
	return apart / Math.max(Math.abs(a), Math.abs(b)) < LENGTH_SAMENESS;
}

/**
 * Two lengths close enough to have been meant as one.
 *
 * Every number is compared, not just the first. A value like a
 * box shadow or a four-sided padding carries several, and
 * reading only the first made every shadow whose x offset is
 * 0px cluster with every other, which is all of them, while
 * `8px 16px` and `8px 4px` read as the same value.
 */
export const lengthsAreNear: Nearness = (one, other) => {
	const a = lengths(one);
	const b = lengths(other);
	if (a.length === 0 || b.length === 0) return false;
	// A different number of parts is a different kind of value.
	if (a.length !== b.length) return false;
	return a.every((value, at) => oneLengthIsNear(value, b[at] ?? Number.NaN));
};

/** Values are the same or they are not. */
export const exactlyEqual: Nearness = (one, other) => one === other;

/** Which properties are worth inventorying, and how they compare. */
export const DIMENSIONS: readonly {
	readonly property: string;
	readonly near: Nearness;
}[] = [
	{ property: "color", near: coloursAreNear },
	{ property: "background-color", near: coloursAreNear },
	{ property: "border-color", near: coloursAreNear },
	{ property: "font-family", near: exactlyEqual },
	{ property: "font-size", near: lengthsAreNear },
	{ property: "font-weight", near: exactlyEqual },
	{ property: "line-height", near: lengthsAreNear },
	{ property: "padding", near: lengthsAreNear },
	{ property: "margin", near: lengthsAreNear },
	{ property: "border-radius", near: lengthsAreNear },
	{ property: "box-shadow", near: lengthsAreNear },
];

/** Take the inventory. */
export function takeInventory(
	samples: readonly StyleSample[],
	dimensions: readonly { property: string; near: Nearness }[] = DIMENSIONS,
): readonly Dimension[] {
	return dimensions
		.map(({ property, near }) => {
			const usages = tallyUsage(samples, property);
			return {
				property,
				distinct: usages.length,
				usages,
				clusters: clusterUsage(usages, near),
			};
		})
		.filter((dimension) => dimension.distinct > 0);
}

/** How many values to list per property before summarising. */
const MAX_LISTED = 8;

/** Say what the page is built from. */
export function renderInventory(
	dimensions: readonly Dimension[],
	options: { readonly property?: string } = {},
): string {
	if (dimensions.length === 0) {
		return renderVerdict(
			{ standing: "warn", headline: "Nothing was sampled from this page." },
			"",
		);
	}

	if (options.property) {
		const found = dimensions.find(
			(dimension) => dimension.property === options.property,
		);
		// Like the audit's rule drill-down, this carries a verdict head
		// so a caller reading the standing gets it from the answer
		// rather than from the shape of the prose.
		if (!found) {
			return renderVerdict(
				{
					standing: "warn",
					headline: `Nothing was sampled for '${options.property}'.`,
					measured: `Sampled: ${dimensions
						.map((dimension) => dimension.property)
						.join(", ")}.`,
				},
				"",
			);
		}
		return renderVerdict(
			{
				standing: found.clusters.length > 0 ? "warn" : "pass",
				headline:
					found.clusters.length > 0
						? `${found.property}: ${found.clusters.length} cluster` +
							`${found.clusters.length === 1 ? "" : "s"} close enough to ` +
							"look accidental."
						: `${found.property}: no two values were close enough to ` +
							"look accidental.",
			},
			renderDimension(found, Number.POSITIVE_INFINITY),
		);
	}

	const drifting = dimensions.filter(
		(dimension) => dimension.clusters.length > 0,
	);
	const values = dimensions.reduce(
		(sum, dimension) => sum + dimension.distinct,
		0,
	);

	const lines: string[] = [];
	for (const dimension of dimensions) {
		lines.push(renderDimension(dimension, MAX_LISTED), "");
	}
	lines.push("Name a property to see every value and where it is used.");

	return renderVerdict(
		{
			// Drift is a question, never a failure. Two blues a step
			// apart may be a hover state, and this cannot tell.
			standing: drifting.length === 0 ? "pass" : "warn",
			headline:
				drifting.length === 0
					? "No two values were close enough to look accidental."
					: `${drifting.length} of ${dimensions.length} properties hold ` +
						"values close enough to have been meant as one.",
			measured: `Sampled ${values} distinct values across ${dimensions.length} properties.`,
		},
		lines.join("\n"),
	);
}

function renderDimension(dimension: Dimension, limit: number): string {
	const head = `${dimension.property}: ${dimension.distinct} distinct`;
	const lines = [
		dimension.clusters.length === 0
			? head
			: `${head}, ${dimension.clusters.length} looking like drift`,
	];

	for (const cluster of dimension.clusters) {
		lines.push(
			`  ${cluster.leader.value} (${cluster.leader.count}) sits beside ` +
				cluster.nearby.map((one) => `${one.value} (${one.count})`).join(", "),
		);
	}

	const shown = dimension.usages.slice(0, limit);
	for (const usage of shown) {
		const where =
			limit === Number.POSITIVE_INFINITY
				? `  ${usage.examples.join(", ")}`
				: "";
		lines.push(
			`    ${String(usage.count).padStart(4)}  ${usage.value}${where}`,
		);
	}
	if (dimension.usages.length > shown.length) {
		lines.push(`    ... and ${dimension.usages.length - shown.length} more`);
	}
	return lines.join("\n");
}
