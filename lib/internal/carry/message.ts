/**
 * What carrying says of something thrown, in a refusal or a line it
 * prints: never a throw of its own, since it is said from a catch, and
 * one there would escape in place of the failure it was saying.
 */

/** Said where what was thrown can't say itself. */
const UNSAID = "something was thrown that can't be put in words";

/**
 * An error's message, or anything else thrown as a string; never
 * throws, though `String` would for a value with no prototype, or one
 * whose `toString` or `message` throws.
 */
export function messageOf(error: unknown): string {
	try {
		return error instanceof Error ? String(error.message) : String(error);
	} catch {
		// What was thrown can't say itself; the failure it stands for still is.
		return UNSAID;
	}
}
