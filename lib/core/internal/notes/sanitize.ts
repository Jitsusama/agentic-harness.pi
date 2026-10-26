/**
 * Filesystem-safe filename sanitizing.
 *
 * Unrelated to quest's `internal/quest/sanitize.ts`, which
 * defends against prompt injection in text the agent reads
 * back. This one has a narrower, mechanical job: take a
 * human title (from an import, or typed by a caller) and
 * produce something every filesystem this tool runs on can
 * actually name a file, without silently truncating or
 * colliding.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control characters from filenames, not matching them as text
const INVALID_CHARS_RE = /[/\\:*?"<>|\x00-\x1f]/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Sanitize a string for use as a filename component (not a
 * full path -- callers add their own extension/directory).
 * Collapses whitespace, strips characters invalid on
 * Windows/macOS/Linux filesystems, trims trailing dots and
 * spaces (Windows rejects both), and clamps length.
 */
export function sanitizeFilename(name: string, maxLen = 150): string {
	// Whitespace normalizes first: \x00-\x1f in INVALID_CHARS_RE
	// includes tab, so running that pass first would turn each tab
	// into its own literal "-" (two tabs -> "--") instead of
	// collapsing the run into a single space the way a space or
	// newline run does.
	const cleaned = name
		.trim()
		.replace(WHITESPACE_RE, " ")
		.replace(INVALID_CHARS_RE, "-")
		.trim()
		.replace(/[. ]+$/, "");
	return (cleaned || "file").slice(0, maxLen);
}
