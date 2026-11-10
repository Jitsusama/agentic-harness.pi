/**
 * JavaScript that runs in the page, kept in files of its own and read in
 * by the module that sends it.
 *
 * A script written as a string in TypeScript is read by no linter or
 * formatter, and its escapes are TypeScript's rather than its own. A
 * `.page.js` beside the module is read as JavaScript by everything that
 * reads JavaScript, Biome included.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The semicolon the formatter ends a file's one statement with. */
const CLOSING_SEMICOLON = /;$/;

/**
 * Read a `.page.js` as the one expression, function or fragment it holds.
 *
 * The formatter ends the file's one statement with a semicolon, which
 * the protocol's evaluate takes but a function handed to callFunctionOn,
 * or a script spliced into another's parentheses, doesn't, so it goes.
 */
export function pageScript(url: URL): string {
	return readFileSync(fileURLToPath(url), "utf8")
		.trimEnd()
		.replace(CLOSING_SEMICOLON, "");
}
