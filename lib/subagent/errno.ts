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
 * Every disallowed character is escaped rather than replaced, which
 * is the part that took three attempts. A leading dot has to go,
 * because `.` and `..` name a directory and its parent and an id of
 * two dots reached a level above the store. Stripping it made `.x`
 * and `x` one name; substituting a dash made `.x` and `-x` one name.
 * Any map that folds two characters into one collides somewhere, and
 * a collision here is two runs sharing the record that decides
 * whether either may be deleted. So the map is reversible, and
 * nothing needs to reverse it: being able to is what makes it
 * injective.
 */
export function safeSegment(value: string): string {
	const escaped = [...value]
		.map((character, at) => {
			const plain = /[a-zA-Z0-9._-]/.test(character);
			// A dot is legal anywhere but the front, where it makes a
			// name that walks rather than a name that reads.
			if (plain && !(at === 0 && character === ".")) return character;
			return [...character]
				.map(
					(part) =>
						`${ESCAPE}${(part.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`,
				)
				.join("");
		})
		.join("");
	return escaped.length > 0 ? escaped : "unknown";
}

/**
 * What an escaped character starts with.
 *
 * Outside the allowed set on purpose, so it escapes itself and two
 * different ids cannot escape to one name.
 */
const ESCAPE = "~";
