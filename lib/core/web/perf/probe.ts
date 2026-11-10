/**
 * Installing the performance observers, and reading them back.
 *
 * The bootstrap has to run before anything on the page does.
 * Largest contentful paint and layout shift are events, not
 * state, and an observer registered after the fact sees only
 * what happens next. Chrome's buffered flag recovers some of it,
 * but not the element that painted or the nodes that moved,
 * which is the part worth having.
 *
 * So it goes in through addScriptToEvaluateOnNewDocument, which
 * fires ahead of every navigation, and the whole thing is
 * wrapped in a try: an observer type the browser does not
 * support must cost the other observers nothing.
 */

import { pageScript } from "../page-script.ts";

/**
 * The script installed before every navigation.
 *
 * Nodes are named the way a person would look for them rather
 * than held as references. A retained node keeps a detached
 * subtree alive, and measuring a page should not change what it
 * costs.
 */
export function observerBootstrap(): string {
	return pageScript(new URL("./observer-bootstrap.page.js", import.meta.url));
}

/** The expression that reads the observers back. */
export function readVitalsSource(): string {
	return pageScript(new URL("./read-vitals.page.js", import.meta.url));
}
