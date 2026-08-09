/**
 * What a filesystem error was, for the cases worth telling apart.
 *
 * These decide whether something is missing or broken, and getting
 * that wrong is expensive in one direction: a caller reading "broken"
 * as "missing" answers "nothing to keep", and a sweep then deletes
 * work nobody has read. So they are one definition rather than a
 * predicate per module.
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

/**
 * A run id as a path segment.
 *
 * One definition because a run id keys two things that have to agree:
 * the directory its transcripts live in, and the ledger record saying
 * whether anything may take them. Two sanitizers meant two ways for
 * distinct ids to collide, differently, so a pair could share a
 * ledger record while owning separate directories, and settling
 * either released the protection on both.
 *
 * Two spellings remain elsewhere in this package, both under
 * `lib/review`, and both key files this never touches. They are not
 * folded in here because `lib/review` and `lib/subagent` are
 * deliberately independent, and a review round's ledger name and a
 * transcript directory name do not have to agree with each other:
 * the agreement this enforces is between the two things keyed by one
 * subagent run id.
 *
 * A leading dot is replaced rather than kept. Keeping it allowed `.`
 * and `..`, which name the directory and its parent, so an id of two
 * dots resolved a ledger file one level above the ledger. The sibling
 * spelling in `lib/review` guarded that and this one, promoted from
 * the artifact store, did not.
 */
export function safeSegment(value: string): string {
	const clean = value
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[.-]+|-+$/g, "");
	return clean.length > 0 ? clean : "unknown";
}
