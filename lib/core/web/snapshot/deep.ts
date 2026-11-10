/**
 * Walking a page the way it is actually built.
 *
 * `document.querySelectorAll` stops at a shadow boundary and at
 * a frame boundary, which means a probe using it sees a design
 * system's markup as a row of empty custom elements. Measured on
 * a two-component page: the flattened snapshot reports eighteen
 * elements and this reported five, so the visual, design, target
 * and keyboard captures each answered questions about a page
 * that was mostly not there. The DOM snapshot pierces both, so
 * the same library was answering the same question two ways.
 *
 * These are page source, in deep-dom.page.js, rather than functions
 * because they
 * are injected into the page, and the bundler renames named
 * inner bindings through a wrapper the page has never heard of.
 *
 * Same-origin only, for frames. A cross-origin iframe runs in
 * another process and its document is unreachable from page
 * script; nothing here can change that, so the count of frames
 * that could not be entered is reported rather than hidden.
 */

import { pageScript } from "../page-script.ts";

/**
 * Declares `deepElements(root)` and `deepSelectorFor(el)`.
 *
 * `deepElements` returns every element under a root, descending
 * through open shadow roots and same-origin frames. Closed
 * shadow roots are not reachable by anyone, including us.
 *
 * `deepSelectorFor` names an element so a reader can find it
 * again, crossing boundaries with the `>>` that Playwright and
 * devtools both use: `my-card >> button` says the button lives
 * inside that component's shadow root.
 */
export const DEEP_DOM = pageScript(
	new URL("./deep-dom.page.js", import.meta.url),
);
