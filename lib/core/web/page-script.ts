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

/** What a page script that is a function is called with. */
export interface PageCall {
	/**
	 * Other page scripts, each an expression the page evaluates into the
	 * helpers it gives, handed in first and in this order.
	 */
	readonly helpers?: readonly string[];
	/** Values the script names, handed in last as one object, as JSON. */
	readonly values?: Readonly<Record<string, unknown>>;
}

/**
 * Read a `.page.js` that holds a function and call it in the page.
 *
 * A script that needs a value from here, or helpers another script
 * gives, takes them as arguments rather than having them spliced into
 * its text, so the file stays JavaScript every tool can read: a helper
 * it uses and isn't handed is an unbound name to the linter, and a
 * value is a parameter rather than a hole in the source.
 */
export function pageCall(url: URL, call: PageCall): string {
	const args = [...(call.helpers ?? [])];
	if (call.values !== undefined) args.push(JSON.stringify(call.values));
	return `(${pageScript(url)})(${args.join(", ")})`;
}
