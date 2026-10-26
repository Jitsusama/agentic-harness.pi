/**
 * Saying what the network said, in the words a person can act on.
 *
 * A navigation that never arrives used to throw the driver's own
 * error, wrapper and stack and all, out through an API whose
 * documentation promised the opposite. The useful part of
 * "net::ERR_INTERNET_DISCONNECTED at http://example.test/, waiting
 * until networkidle2" is the first token, and the rest is noise
 * that pushes it off the line.
 *
 * The message is the browser's; the tidying is ours, and it is
 * only tidying. Nothing here decides whether a failure happened
 * or invents a reason for one.
 */

/** Chrome's own error codes, which read well enough as they are. */
const CHROME_CODE = /\b(net::[A-Z_]+)\b/;

/** What the driver adds around the message, and we take off. */
const DRIVER_NOISE: readonly RegExp[] = [
	/^Error:\s*/i,
	/^Navigation failed because\s*/i,
	/\s+at\s+https?:\/\/\S+/,
	/,?\s*waiting until\s+\S+/i,
];

/**
 * What the driver says when the thing it was driving died.
 *
 * These are about the tab going away underneath a call, which is
 * a different event from the network refusing to answer. A
 * navigation that provokes a crash is aborted rather than
 * detached, and it must not match: retrying it would kill the
 * replacement tab as reliably as it killed the first one.
 */
const DIED_WITH_THE_TAB: readonly RegExp[] = [
	/frame was detached/i,
	/session closed/i,
	/target closed/i,
	/target crashed/i,
];

/**
 * Whether a failure means the tab died under the operation.
 *
 * Chrome reports the death to whoever was driving the tab before
 * it announces the crash that caused it, so a caller that reads
 * only "is a recovery under way" concludes no and hands its next
 * call to the corpse. Recognising the failure is what lets the
 * call wait for the replacement instead of being lost.
 */
export function diedWithTheTab(failure: string): boolean {
	return DIED_WITH_THE_TAB.some((pattern) => pattern.test(failure));
}

/**
 * The one line worth showing for a thrown navigation failure.
 *
 * Chrome's error code wins when there is one, since it is the
 * thing worth searching for and the thing a reader recognises.
 */
export function failureText(error: unknown): string {
	const raw =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: String(error);
	const code = CHROME_CODE.exec(raw);
	if (code?.[1]) return code[1];
	const tidied = DRIVER_NOISE.reduce(
		(said, noise) => said.replace(noise, ""),
		raw,
	)
		.split("\n")[0]
		?.trim();
	// An error with nothing to say still has to say something, or
	// the caller reports a failure with a blank reason.
	return tidied && tidied.length > 0 ? tidied : "the navigation failed";
}
