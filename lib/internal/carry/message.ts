/**
 * What carrying says of something thrown, in a refusal or a line it
 * prints: never a throw of its own, since it is said from a catch, and
 * one there would escape in place of the failure it was saying.
 */

/** Said where what was thrown can't say itself. */
const UNSAID = "something was thrown that can't be put in words";

/** Said where what was thrown says nothing, as `new Error()` does. */
const SILENT = "something was thrown that said nothing of why";

/**
 * An error's message, or anything else thrown as a string, saying so
 * where it is empty; never throws, though `String` would for a value
 * with no prototype, or one whose `toString` or `message` throws.
 */
export function messageOf(error: unknown): string {
	try {
		const said = error instanceof Error ? String(error.message) : String(error);
		return said === "" ? SILENT : said;
	} catch {
		// What was thrown can't say itself; the failure it stands for still is.
		return UNSAID;
	}
}
