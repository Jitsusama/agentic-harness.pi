/**
 * Page-side answers to "is this actually being offered to
 * anybody", shared by every probe that has to decide.
 *
 * This is page source, in presented.page.js, like the deep
 * traversal it sits beside, because it declares helpers of its own and the bundler
 * renames named inner bindings through a wrapper the page has
 * never heard of.
 *
 * It exists because four probes asked this question three
 * different ways. Two settled for a bare checkVisibility(), which
 * answers about display and nothing else, and the disagreement
 * showed up as false findings rather than as a disagreement: a
 * real app's closed dialogs were reported as 48 critical
 * accessibility failures and its screen-reader-only inputs as ten
 * pointer targets one pixel across.
 *
 * The recognition of a visually-hidden idiom is presentational
 * judgment rather than measurement, and is one of this library's
 * declared exceptions to reporting only what the browser said.
 * The browser has no notion of the idiom; without it, every
 * correctly built skip link on every page is a finding.
 */

import { pageCall } from "../page-script.ts";

/** A box no larger than this is a hiding technique, not content. */
export const HIDDEN_BOX_PX = 4;

/**
 * Gives `presented`, `visible`, `inertHere` and `visuallyHidden`
 * to a page-side probe, which takes them as an argument through
 * pageCall's helpers, as with DEEP_DOM.
 */
export const PRESENTED = pageCall(
	new URL("./presented.page.js", import.meta.url),
	{ values: { HIDDEN_BOX_PX } },
);
