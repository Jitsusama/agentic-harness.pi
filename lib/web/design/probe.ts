/**
 * Sampling what the page is built from.
 *
 * Every value is a resolved computed style, which is the only
 * honest source: the stylesheet says what was asked for, and the
 * computed style says what the element got after the cascade,
 * custom properties, media queries and inheritance all had their
 * turn. An inventory built from CSS text would describe the
 * intent rather than the page.
 *
 * Inherited values are the one thing filtered out, and for a
 * reason worth stating: every element inherits a colour, so
 * sampling all of them makes the body text look like the most
 * popular decision on the page when nobody decided it at all.
 */

/** The properties worth sampling, in the order they are read. */
import { DEEP_DOM } from "../snapshot/deep.js";
import { PRESENTED } from "../snapshot/presented.js";

export const SAMPLED_PROPERTIES = [
	"color",
	"background-color",
	"border-color",
	"font-family",
	"font-size",
	"font-weight",
	"line-height",
	"padding",
	"margin",
	"border-radius",
	"box-shadow",
] as const;

/**
 * Build the expression that samples the page's styles.
 *
 * A value is kept only where the element differs from its
 * parent, which is what turns "every element is 16px" into "one
 * element chose 14px".
 */
export function inventorySource(): string {
	return `(() => {
	${DEEP_DOM}
	${PRESENTED}
	const PROPERTIES = ${JSON.stringify(SAMPLED_PROPERTIES)};

	const NOTHING = new Set([
		"none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)", "0px 0px 0px 0px",
	]);

	const samples = [];
	for (const el of deepElements(document)) {
		const tag = el.tagName.toLowerCase();
		if (tag === "script" || tag === "style" || tag === "head") continue;
		// An inventory of what the design actually looks like, so it
		// samples what somebody can actually see: not a closed
		// dialog's contents, and not a screen-reader-only label whose
		// colours nobody ever looks at.
		if (!presented(el)) continue;

		const own = getComputedStyle(el);
		const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;

		// A border colour with no border is not a decision. Its
		// initial value is currentColor, so every element reports
		// one, and sampling them all just echoes the colour list
		// back under a second heading.
		const hasBorder =
			own.borderStyle !== "none" &&
			parseFloat(own.borderTopWidth) +
				parseFloat(own.borderRightWidth) +
				parseFloat(own.borderBottomWidth) +
				parseFloat(own.borderLeftWidth) >
				0;

		const values = {};
		for (const property of PROPERTIES) {
			if (property === "border-color" && !hasBorder) continue;
			const value = own.getPropertyValue(property);
			if (!value || NOTHING.has(value)) continue;
			// Only what this element decided, not what it was handed.
			if (parent && parent.getPropertyValue(property) === value) continue;
			values[property] = value;
		}
		if (Object.keys(values).length === 0) continue;
		samples.push({ selector: deepSelectorFor(el), values });
	}
	return samples;
})()`;
}
