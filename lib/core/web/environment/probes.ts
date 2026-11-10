/**
 * Asking the page what it is actually experiencing.
 *
 * Page source rather than a function, for the same reason the
 * accessibility observer is: the compiler wraps named inner
 * bindings in a __name helper the page has never heard of, so
 * a serialized function that declares helpers of its own throws
 * on arrival.
 */

import { pageScript } from "../page-script.ts";

/**
 * Read the environment as the page sees it.
 *
 * Every value here comes from the page's own APIs rather than
 * from what we asked the browser for, because the two differ
 * often enough that reporting the request would be reporting a
 * guess.
 */
export const ENVIRONMENT_PROBE = pageScript(
	new URL("./environment-probe.page.js", import.meta.url),
);
