/**
 * Which computed styles are worth reading.
 *
 * A capture carries around 480 properties, some 11 KB of text,
 * and most of them sit at a value nobody chose. Dumping that
 * buries the handful that explain why an element looks and
 * lays out the way it does. This keeps the curated set, groups
 * it by concern, and drops anything still at its initial value.
 *
 * Which values count as untouched is the browser's to say, not
 * this module's. The caller reads them from the page and hands
 * them in; see INITIALS_PROBE.
 */

/** Computed styles as captured: property name to value. */
export type ComputedStyles = Readonly<Record<string, string>>;

/** One property and the value it computed to. */
export interface StyleEntry {
	readonly property: string;
	readonly value: string;
}

/** Curated properties that share a concern. */
export interface StyleGroup {
	readonly name: string;
	readonly entries: readonly StyleEntry[];
}

/** How to curate. */
export interface CurateOptions {
	/** Exactly these properties, overriding curation entirely. */
	readonly only?: readonly string[];
	/** Keep properties still at their initial value. */
	readonly all?: boolean;
	/**
	 * What each property computes to when nobody has set it, as
	 * the browser reports it for an element with all:initial.
	 *
	 * Without this nothing is suppressed as a default. Keeping a
	 * table of initial values here would be restating what the
	 * browser already knows, and getting it wrong quietly: the
	 * initial outline-width is 3px, not the 0px an author would
	 * assume.
	 */
	readonly initials?: ComputedStyles;
}

/**
 * The curated set, in reading order.
 *
 * Order within a group is the order declared here rather than
 * capture order, so two reads of an unchanged element are
 * diffable.
 */
const CURATED: readonly { name: string; properties: readonly string[] }[] = [
	{
		name: "box",
		properties: [
			"display",
			"position",
			"inset",
			"top",
			"right",
			"bottom",
			"left",
			"width",
			"height",
			"min-width",
			"min-height",
			"max-width",
			"max-height",
			"box-sizing",
			"margin",
			"margin-top",
			"margin-right",
			"margin-bottom",
			"margin-left",
			"padding",
			"padding-top",
			"padding-right",
			"padding-bottom",
			"padding-left",
			"border-width",
			"border-top-width",
			"border-right-width",
			"border-bottom-width",
			"border-left-width",
			"overflow-x",
			"overflow-y",
			"float",
			"clear",
		],
	},
	{
		name: "layout",
		properties: [
			"flex-direction",
			"flex-wrap",
			"justify-content",
			"align-items",
			"align-self",
			"align-content",
			"flex-grow",
			"flex-shrink",
			"flex-basis",
			"order",
			"gap",
			"row-gap",
			"column-gap",
			"grid-template-columns",
			"grid-template-rows",
			"grid-template-areas",
			"grid-area",
			"grid-column",
			"grid-row",
		],
	},
	{
		name: "typography",
		properties: [
			"font-family",
			"font-size",
			"font-weight",
			"font-style",
			"line-height",
			"letter-spacing",
			"word-spacing",
			"text-align",
			"text-transform",
			"text-decoration-line",
			"text-overflow",
			"white-space",
			"vertical-align",
		],
	},
	{
		name: "paint",
		properties: [
			"color",
			"background-color",
			"background-image",
			"border-style",
			"border-top-style",
			"border-right-style",
			"border-bottom-style",
			"border-left-style",
			"border-color",
			"border-top-color",
			"border-right-color",
			"border-bottom-color",
			"border-left-color",
			"border-top-left-radius",
			"border-top-right-radius",
			"border-bottom-right-radius",
			"border-bottom-left-radius",
			"outline-width",
			"outline-style",
			"outline-color",
			"outline-offset",
			"box-shadow",
			"text-shadow",
			"opacity",
			"filter",
			"backdrop-filter",
			"mix-blend-mode",
		],
	},
	{
		name: "interaction",
		properties: [
			"visibility",
			"cursor",
			"pointer-events",
			"user-select",
			"z-index",
			"resize",
			"touch-action",
			"accent-color",
		],
	},
	{
		name: "motion",
		properties: [
			"transform",
			"transform-origin",
			"transition-property",
			"transition-duration",
			"transition-timing-function",
			"transition-delay",
			"animation-name",
			"animation-duration",
			"animation-timing-function",
			"animation-iteration-count",
			"animation-play-state",
			"will-change",
		],
	},
];

/** The sides a border is described one at a time. */
const SIDES = ["top", "right", "bottom", "left"] as const;

/** Whether a value is present and something other than none. */
function inEffect(value: string | undefined): boolean {
	return value !== undefined && value !== "none";
}

/** Whether this side actually paints a border. */
function hasBorder(styles: ComputedStyles, side: string): boolean {
	if (!inEffect(styles[`border-${side}-style`])) return false;
	return styles[`border-${side}-width`] !== "0px";
}

/**
 * Properties that only mean something when another property is
 * in effect. Chrome resolves several initial values into
 * concrete numbers, so a value that differs from its initial
 * is not proof that it does anything: an outline width of 3px
 * paints nothing while the outline style is none.
 */
const RELEVANT_WHEN: Readonly<
	Record<string, (styles: ComputedStyles) => boolean>
> = {
	...Object.fromEntries(
		SIDES.flatMap((side) => [
			[
				`border-${side}-color`,
				(styles: ComputedStyles) => hasBorder(styles, side),
			],
			[
				`border-${side}-style`,
				(styles: ComputedStyles) => hasBorder(styles, side),
			],
		]),
	),
	"border-color": (styles) => inEffect(styles["border-style"]),
	"outline-color": (styles) => inEffect(styles["outline-style"]),
	"outline-offset": (styles) => inEffect(styles["outline-style"]),
	"outline-width": (styles) => inEffect(styles["outline-style"]),
	"transform-origin": (styles) => inEffect(styles.transform),
};

/** Curate a capture into groups worth reading. */
export function curateStyles(
	styles: ComputedStyles,
	options: CurateOptions = {},
): readonly StyleGroup[] {
	if (options.only) return requested(styles, options.only);

	// Asking for everything means the capture as it was read.
	const covered = options.all ? new Set<string>() : sidesCoveredBy(styles);

	const groups: StyleGroup[] = [];
	for (const { name, properties } of CURATED) {
		const entries: StyleEntry[] = [];
		for (const property of properties) {
			const value = styles[property];
			if (value === undefined) continue;
			if (options.all) {
				entries.push({ property, value });
				continue;
			}
			if (covered.has(property)) continue;
			if (value === options.initials?.[property]) continue;
			if (RELEVANT_WHEN[property]?.(styles) === false) continue;
			entries.push({ property, value });
		}
		if (entries.length > 0) groups.push({ name, entries });
	}
	return groups;
}

/**
 * Shorthands and the sides they stand for.
 *
 * The browser serializes these itself, so when a capture
 * carries one it is used and its sides are left out. Nothing
 * here computes a shorthand: CSS serialization has rules about
 * uneven sides and omitted values that only the browser can be
 * trusted to apply.
 */
const SHORTHANDS: readonly { shorthand: string; sides: readonly string[] }[] = [
	{ shorthand: "margin", sides: SIDES.map((side) => `margin-${side}`) },
	{ shorthand: "padding", sides: SIDES.map((side) => `padding-${side}`) },
	{ shorthand: "inset", sides: [...SIDES] },
	{
		shorthand: "border-width",
		sides: SIDES.map((side) => `border-${side}-width`),
	},
	{
		shorthand: "border-style",
		sides: SIDES.map((side) => `border-${side}-style`),
	},
	{
		shorthand: "border-color",
		sides: SIDES.map((side) => `border-${side}-color`),
	},
];

/** Sides the capture already stated as a shorthand. */
function sidesCoveredBy(styles: ComputedStyles): ReadonlySet<string> {
	const covered = new Set<string>();
	for (const { shorthand, sides } of SHORTHANDS) {
		if (styles[shorthand] === undefined) continue;
		for (const side of sides) covered.add(side);
	}
	return covered;
}

/**
 * Exactly what was asked for, in the order it was asked for.
 * An explicit request overrides curation, including the rule
 * about initial values: the caller knows something the curated
 * set does not.
 */
function requested(
	styles: ComputedStyles,
	properties: readonly string[],
): readonly StyleGroup[] {
	const entries: StyleEntry[] = [];
	for (const property of properties) {
		const value = styles[property];
		if (value !== undefined) entries.push({ property, value });
	}
	return entries.length > 0 ? [{ name: "requested", entries }] : [];
}
