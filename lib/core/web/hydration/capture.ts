/**
 * Reading the server render and the hydrated page side by side.
 *
 * The server's HTML is fetched from inside the page, so it
 * travels with the session's own cookies and headers, and it is
 * parsed with DOMParser, which builds a document without running
 * a single script: exactly what the browser had before hydration
 * ran. Both documents are reduced to the same compact shape,
 * text and tag counts, because the judgment belongs to the pure
 * side and whole DOM trees do not fit through a capture.
 */

import { pageCall } from "../page-script.ts";

/** Both renders, reduced to comparable shape. */
export interface HydrationCapture {
	readonly url: string;
	/** Whether the server render could be fetched at all. */
	readonly fetched: boolean;
	readonly status?: number;
	readonly serverTexts: readonly string[];
	readonly clientTexts: readonly string[];
	readonly serverTags: Readonly<Record<string, number>>;
	readonly clientTags: Readonly<Record<string, number>>;
}

/** Texts shorter than this are markup lint, not content. */
export const MIN_TEXT_CHARS = 3;

/** How many texts to carry per side. */
export const MAX_TEXTS = 500;

/** How much of each text to keep. */
export const MAX_TEXT_CHARS = 120;

/**
 * The expression that reads both renders.
 *
 * Async because the server render is a fetch; evaluate it with
 * awaitPromise. Scripts, styles and noscript are excluded from
 * both sides: they are machinery, not content, and noscript text
 * is visible in exactly one of the two renders by definition.
 */
export const HYDRATION_CAPTURE = pageCall(
	new URL("./hydration-capture.page.js", import.meta.url),
	{
		values: { MIN_TEXT: MIN_TEXT_CHARS, MAX_TEXTS, MAX_CHARS: MAX_TEXT_CHARS },
	},
);
