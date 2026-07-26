/**
 * Why a property has the value it has.
 *
 * The browser has already done the hard parts: which selectors
 * match, how specific they are, which media queries apply, and
 * what order that puts the rules in. None of that is redone
 * here. A capture arrives with the rules in ascending order of
 * strength and this reads them back the way a person asks the
 * question, strongest first, with the winner named.
 *
 * One declared exception: which properties inherit. The protocol
 * reports an ancestor's whole matched rule and has no call that
 * answers whether a given property inherits, so that set is
 * written down here from the specification. It is stable, it is
 * finite, and without it an ancestor's padding is offered as an
 * explanation for a child's padding, which is how a rule that
 * had no say came to be named the winner.
 */

/**
 * The properties that inherit, per the CSS specification.
 *
 * Only these can be supplied to a child by an ancestor, so only
 * these belong in the inherited band of a trace. Shorthands are
 * listed beside their longhands because a capture reports both.
 */
const INHERITED_PROPERTIES = new Set([
	"azimuth",
	"border-collapse",
	"border-spacing",
	"caption-side",
	"caret-color",
	"color",
	"color-scheme",
	"cursor",
	"direction",
	"empty-cells",
	"font",
	"font-family",
	"font-feature-settings",
	"font-kerning",
	"font-language-override",
	"font-optical-sizing",
	"font-size",
	"font-size-adjust",
	"font-stretch",
	"font-style",
	"font-synthesis",
	"font-variant",
	"font-variant-caps",
	"font-variant-east-asian",
	"font-variant-ligatures",
	"font-variant-numeric",
	"font-variation-settings",
	"font-weight",
	"hanging-punctuation",
	"hyphens",
	"image-orientation",
	"image-rendering",
	"letter-spacing",
	"line-break",
	"line-height",
	"list-style",
	"list-style-image",
	"list-style-position",
	"list-style-type",
	"orphans",
	"overflow-wrap",
	"paint-order",
	"pointer-events",
	"quotes",
	"ruby-align",
	"ruby-position",
	"tab-size",
	"text-align",
	"text-align-last",
	"text-anchor",
	"text-combine-upright",
	"text-decoration-skip-ink",
	"text-emphasis",
	"text-emphasis-color",
	"text-emphasis-position",
	"text-emphasis-style",
	"text-indent",
	"text-justify",
	"text-orientation",
	"text-rendering",
	"text-shadow",
	"text-size-adjust",
	"text-transform",
	"text-underline-offset",
	"text-underline-position",
	"text-wrap",
	"visibility",
	"white-space",
	"widows",
	"word-break",
	"word-spacing",
	"writing-mode",
	"-webkit-font-smoothing",
	"-webkit-text-fill-color",
	"-webkit-text-stroke",
	"-webkit-text-stroke-color",
	"-webkit-text-stroke-width",
]);

/**
 * Whether an ancestor's declaration of this property can reach a
 * descendant. Custom properties always can.
 */
export function inherits(property: string): boolean {
	return property.startsWith("--") || INHERITED_PROPERTIES.has(property);
}

/** A declaration as the capture reported it. */
export interface RawCssProperty {
	readonly name: string;
	readonly value: string;
	/**
	 * The declaration as written. Present on authored
	 * declarations; absent on browser defaults and on the
	 * longhands a rule reports after them.
	 */
	readonly text?: string;
	readonly important?: boolean;
	readonly disabled?: boolean;
	readonly range?: { readonly startLine: number; readonly startColumn: number };
	/** The sides a shorthand expands to, as the capture lists them. */
	readonly longhandProperties?: readonly {
		readonly name: string;
		readonly value?: string;
	}[];
}

/** A rule as the capture reported it. */
export interface RawCssRule {
	/** "user-agent" for browser defaults, "regular" for authored. */
	readonly origin: string;
	readonly selectorList: { readonly text: string };
	readonly styleSheetId?: string;
	readonly media?: readonly { readonly text: string }[];
	readonly style: { readonly cssProperties: readonly RawCssProperty[] };
}

/** A rule match as the capture reported it. */
export interface RawRuleMatch {
	readonly rule: RawCssRule;
}

/** Matched styles as the capture reported them. */
export interface RawMatchedStyles {
	readonly inlineStyle?: {
		readonly cssProperties: readonly RawCssProperty[];
	};
	readonly matchedCSSRules?: readonly RawRuleMatch[];
	readonly inherited?: readonly {
		readonly matchedCSSRules?: readonly RawRuleMatch[];
	}[];
}

/** Where a declaration came from. */
export type DeclarationOrigin =
	| "user-agent"
	| "author"
	| "inline"
	| "inherited";

import type { AuthoredPosition } from "../sourcemap/index.js";

/** One declaration that had a say in a property's value. */
export interface Declaration {
	readonly property: string;
	readonly value: string;
	readonly important: boolean;
	readonly origin: DeclarationOrigin;
	readonly selector?: string;
	readonly media?: readonly string[];
	readonly source?: {
		readonly styleSheet?: string;
		readonly line?: number;
		readonly column?: number;
		/** Where the rule was written, when a source map said. */
		readonly authored?: AuthoredPosition;
	};
	/** The shorthand that set this, when a shorthand did. */
	readonly via?: string;
}

/** Everything that had a say in one property, strongest first. */
export interface PropertyTrace {
	readonly property: string;
	/** What the property actually computed to, when known. */
	readonly computed?: string;
	readonly declarations: readonly Declaration[];
	readonly winner?: Declaration;
}

/** Flatten a capture into declarations, weakest first. */
export function normalizeCascade(
	raw: RawMatchedStyles,
): readonly Declaration[] {
	const declarations: Declaration[] = [];

	// Furthest ancestor first. The protocol reports the chain from
	// the immediate parent upward, and the tie-break among equal
	// weights takes the declaration that came last, so pushing the
	// chain as given crowned the root over the nearer ancestor.
	// Measured on a two-ancestor page: .outer beat .mid.
	//
	// Only properties that inherit are kept. An ancestor's padding
	// is not a candidate for a child's padding, and including it
	// let a rule that had no say be named the winner over the
	// value the browser actually computed.
	for (const { matchedCSSRules } of [...(raw.inherited ?? [])].reverse()) {
		for (const match of matchedCSSRules ?? []) {
			declarations.push(
				...fromRule(match.rule, "inherited").filter((declaration) =>
					inherits(declaration.property),
				),
			);
		}
	}
	for (const match of raw.matchedCSSRules ?? []) {
		const origin = match.rule.origin === "user-agent" ? "user-agent" : "author";
		declarations.push(...fromRule(match.rule, origin));
	}
	const inline = raw.inlineStyle;
	if (inline) {
		declarations.push(
			...fromRule(
				{ origin: "inline", selectorList: { text: "" }, style: inline },
				"inline",
			).map(({ selector: _unused, ...rest }) => rest),
		);
	}
	return declarations;
}

/**
 * The declarations one rule makes.
 *
 * A rule reports what was authored and then the full set of
 * longhands it ends up setting, so the same property can arrive
 * twice. The authored form is kept, because only it can say
 * where it was written. A longhand with no authored form of its
 * own is still a real declaration: a rule saying padding: 8px
 * genuinely sets padding-top, and a trace that hid that would
 * come back empty for a property something plainly set.
 */
function fromRule(
	rule: RawCssRule,
	origin: DeclarationOrigin,
): readonly Declaration[] {
	// An ordinary rule reports media as an empty list, which
	// reads as a media query if taken at face value.
	const queries = rule.media?.map((query) => query.text) ?? [];
	const media = queries.length > 0 ? queries : undefined;
	const context = {
		selector: rule.selectorList.text,
		styleSheet: rule.styleSheetId,
		media,
	};

	const shorthandOf = shorthandsBySide(rule.style.cssProperties);
	const byProperty = new Map<string, Declaration>();
	for (const property of rule.style.cssProperties) {
		if (property.disabled) continue;
		// The authored form arrives first and is the richer one.
		if (byProperty.has(property.name)) continue;
		byProperty.set(
			property.name,
			fromProperty(property, origin, {
				...context,
				via: shorthandOf.get(property.name),
			}),
		);
	}
	return [...byProperty.values()];
}

/** Which shorthand, if any, produced each side. */
function shorthandsBySide(
	properties: readonly RawCssProperty[],
): ReadonlyMap<string, string> {
	const bySide = new Map<string, string>();
	for (const property of properties) {
		for (const side of property.longhandProperties ?? []) {
			bySide.set(side.name, property.name);
		}
	}
	return bySide;
}

/** One declaration, with whatever the capture knows about it. */
function fromProperty(
	property: RawCssProperty,
	origin: DeclarationOrigin,
	context: {
		selector?: string;
		styleSheet?: string;
		media?: readonly string[];
		via?: string;
	} = {},
): Declaration {
	const source = sourceOf(context.styleSheet, property.range);
	const important = property.important === true;
	return {
		property: property.name,
		value: important ? withoutImportance(property.value) : property.value,
		important,
		origin,
		...(context.selector === undefined ? {} : { selector: context.selector }),
		...(context.media === undefined ? {} : { media: context.media }),
		...(source === undefined ? {} : { source }),
		...(context.via === undefined ? {} : { via: context.via }),
	};
}

/**
 * Drop the importance token from a value that already carries
 * the flag, so a reading does not say it twice. Only applied
 * where the capture set the flag, which is what makes the
 * trailing token safe to remove rather than guessed at.
 */
function withoutImportance(value: string): string {
	return value.replace(/\s*!\s*important\s*$/i, "");
}

/** Where a declaration was written, when the capture says. */
function sourceOf(
	styleSheet: string | undefined,
	range: RawCssProperty["range"],
): Declaration["source"] {
	if (styleSheet === undefined && range === undefined) return undefined;
	return {
		...(styleSheet === undefined ? {} : { styleSheet }),
		...(range === undefined
			? {}
			: { line: range.startLine, column: range.startColumn }),
	};
}

/**
 * How much weight a declaration carries, ignoring the ordering
 * the browser already applied.
 *
 * This is the one part of the cascade a capture leaves to its
 * reader. The browser sorts matched rules by specificity and
 * document order but reports importance as a flag, so an
 * important declaration can arrive in a weak position and still
 * win. Chrome's own devtools front end works this out the same
 * way.
 */
function weightOf(declaration: Declaration): number {
	// The cascade's origin order, weakest first, with importance
	// folded in rather than added on top.
	//
	// A flat bonus for importance got two things wrong. It let an
	// inherited important declaration beat the element's own rule,
	// and it put an author important declaration above a
	// user-agent important one, which inverts the spec.
	//
	// Inheritance stays at the bottom whatever its importance,
	// because importance is resolved during the parent's own
	// cascade and an inherited value only reaches the child when
	// the child declares nothing itself. Measured: with
	// `body { color: red !important }` above `.btn { color: navy }`
	// the browser renders navy, and this used to report red.
	const RANK: Record<DeclarationOrigin, { normal: number; important: number }> =
		{
			inherited: { normal: 0, important: 1 },
			"user-agent": { normal: 2, important: 7 },
			author: { normal: 3, important: 5 },
			inline: { normal: 4, important: 6 },
		};
	const rank = RANK[declaration.origin];
	return declaration.important ? rank.important : rank.normal;
}

/** Read back everything that had a say in one property. */
export function traceProperty(
	declarations: readonly Declaration[],
	property: string,
	computed?: string,
): PropertyTrace {
	const having = declarations
		.map((declaration, order) => ({ declaration, order }))
		.filter(({ declaration }) => declaration.property === property);

	// Strongest first: by weight, and among equals the one the
	// browser put last.
	const ranked = having
		.sort((left, right) => {
			const byWeight = weightOf(right.declaration) - weightOf(left.declaration);
			return byWeight !== 0 ? byWeight : right.order - left.order;
		})
		.map(({ declaration }) => declaration);

	return {
		property,
		...(computed === undefined ? {} : { computed }),
		declarations: ranked,
		...(ranked[0] === undefined ? {} : { winner: ranked[0] }),
	};
}
