/**
 * Turning caller-chosen words into one safe path component.
 *
 * Session names and baseline labels are chosen by whoever is
 * driving, which in practice means a language model, and both end
 * up joined onto a directory. A name of "../../../../tmp/evil"
 * put a baseline write at /Users/tmp/evil rather than under the
 * extension's data directory, because only the label was being
 * cleaned and the session name went through untouched.
 *
 * The rule is stated once here and used by both, so the next
 * caller-chosen word that becomes a path gets it for free rather
 * than repeating the omission.
 */

/** What is allowed to survive into a path component. */
const UNSAFE = /[^a-zA-Z0-9._-]+/g;

/**
 * A name to fall back on when nothing usable is left.
 *
 * Something has to be written somewhere, and an empty component
 * makes path.join silently return the parent directory, which is
 * how a file lands one level up from where it was meant to.
 */
const FALLBACK = "unnamed";

/**
 * One path component, safe to join onto a directory.
 *
 * Refuses nothing and always returns something joinable. A name
 * made entirely of separators becomes the fallback rather than an
 * error, because the caller asked to look at a page, not to be
 * lectured about their session name.
 */
export function pathComponent(value: string): string {
	// "." and ".." survive the character filter untouched, and both
	// mean a directory rather than a name. Stripping the leading dots
	// handles those and the merely-hidden ".secret" in one move, but
	// it can empty the name outright, which is why the fallback is
	// applied after it rather than before: "..." cleaned first and
	// checked second came back as the empty string, and path.join of
	// an empty component returns the parent directory.
	const cleaned = value.replace(UNSAFE, "-").replace(/^\.+/, "");
	return cleaned === "" ? FALLBACK : cleaned;
}
