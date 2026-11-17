/**
 * Sanitizers for text that flows from external sources
 * (GitHub PR titles, issue bodies, third-party author
 * handles) into a quest README that the agent then reads
 * back as part of its context.
 *
 * The concern is not classic XSS: the README is markdown
 * the agent renders. The concern is that an attacker who
 * controls a PR title or body can shape the structure of
 * the README so the agent reads it as instructions ("##
 * Important: ignore all prior instructions"). We strip
 * the structural markers we know the README parser cares
 * about, and clamp lengths so a hostile excerpt cannot
 * shove the rest of the document out of the agent's
 * context window.
 *
 * These helpers are defensive, not exhaustive. Callers
 * should think about what they're templating in.
 */

const MAX_TITLE_LENGTH = 200;
const MAX_HANDLE_LENGTH = 64;
const MAX_EXCERPT_LENGTH = 400;

/**
 * Strip newlines, collapse whitespace and clamp length.
 * Use for single-line fields: titles, handles, captions.
 */
export function sanitizeSingleLine(
	value: string,
	maxLen = MAX_TITLE_LENGTH,
): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLen);
}

/**
 * Escape leading markdown structure markers so a hostile
 * excerpt cannot pose as a heading, bullet, code fence or
 * frontmatter delimiter on its own line. Each affected
 * line gets a leading zero-width space, which renders
 * invisibly but breaks the regex-anchored markdown
 * extractors the quest tooling uses.
 *
 * Newlines inside the value are preserved.
 */
export function escapeMarkdownStructure(value: string): string {
	return value
		.split("\n")
		.map((line) => {
			if (/^\s*(#|---|```|>|\*\s|-\s|\d+\.\s)/.test(line)) {
				return `\u200b${line}`;
			}
			return line;
		})
		.join("\n");
}

/**
 * Sanitize an excerpt: clamp length, escape leading
 * structure markers, strip carriage returns.
 */
export function sanitizeExcerpt(value: string): string {
	const trimmed = value.replace(/\r/g, "").trim();
	const clamped =
		trimmed.length > MAX_EXCERPT_LENGTH
			? `${trimmed.slice(0, MAX_EXCERPT_LENGTH)}...`
			: trimmed;
	return escapeMarkdownStructure(clamped);
}

/** Sanitize a handle for inline display (`@<login>`). */
export function sanitizeHandle(value: string): string {
	return sanitizeSingleLine(value, MAX_HANDLE_LENGTH).replace(
		/[^A-Za-z0-9._-]/g,
		"",
	);
}
