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

import { pageCall } from "../page-script.ts";
/** The properties worth sampling, in the order they are read. */
import { DEEP_DOM } from "../snapshot/deep.ts";
import { PRESENTED } from "../snapshot/presented.ts";

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
	return pageCall(new URL("./inventory.page.js", import.meta.url), {
		helpers: [DEEP_DOM, PRESENTED],
		values: { PROPERTIES: SAMPLED_PROPERTIES },
	});
}
