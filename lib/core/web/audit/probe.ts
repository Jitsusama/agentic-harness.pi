/**
 * Asking the page what its layout did.
 *
 * Every number here is one the browser computed: bounding
 * rectangles, scroll against client dimensions, the resolved
 * overflow, an image's own size. None of it is derived from CSS
 * text, because the CSS is not what happened, the layout is.
 *
 * It is page source, in a .page.js beside this module, because
 * it declares helpers, and
 * the bundler rewrites named inner bindings through a wrapper
 * the page does not have.
 */

import { pageCall } from "../page-script.ts";
import { DEEP_DOM } from "../snapshot/deep.ts";
import { PRESENTED } from "../snapshot/presented.ts";

/** How much text to carry back per element. */
const MAX_TEXT = 120;

/**
 * Build the expression that collects the layout capture.
 *
 * Only elements the browser actually drew are collected, since
 * a rule about how something looks has nothing to say about
 * something that was never painted.
 */
export function visualCaptureSource(): string {
	return pageCall(new URL("./visual-capture.page.js", import.meta.url), {
		helpers: [DEEP_DOM, PRESENTED],
		values: { MAX_TEXT },
	});
}

/**
 * Collect every pointer target on the page with the facts WCAG
 * 2.5.8 needs to judge it.
 *
 * The two exceptions the criterion turns on are both facts about
 * layout that only the browser can settle, so both are measured
 * here rather than guessed from a tag name. A target is inline
 * when the browser lays it out inline inside a run of text, and
 * user-agent controlled when the page sets no size for it.
 */
export const TARGET_CAPTURE = pageCall(
	new URL("./target-capture.page.js", import.meta.url),
	{ helpers: [DEEP_DOM, PRESENTED] },
);
