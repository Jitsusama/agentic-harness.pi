/**
 * What a filesystem error was, for the two cases worth telling apart.
 *
 * Both of these decide whether something is missing or broken, and
 * getting that wrong here is expensive in one direction: a caller
 * that reads "broken" as "missing" answers "nothing to keep" and a
 * sweep deletes work nobody has read. So they are one definition
 * rather than a predicate per module, which is how the sweep and the
 * fleet ledger came to disagree about EISDIR.
 */

/** Whether this failed because there is nothing at that path. */
export function isNotFound(error: unknown): boolean {
	return codeOf(error) === "ENOENT";
}

/** Whether this failed because the path is a directory. */
export function isDirectory(error: unknown): boolean {
	return codeOf(error) === "EISDIR";
}

/** The errno a failure carries, if it carries one. */
function codeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
