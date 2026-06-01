/**
 * Section convention detection: finds headings in a PR or issue
 * body that are not in the sanctioned set (invented) and
 * sanctioned headings that the body omits (missing). The
 * sanctioned set is a closed list of exact heading strings,
 * including the heading level and the emoji, so a sanctioned
 * name at the wrong level or with a swapped emoji reads as
 * invented. Detection never rewrites; it names the offending or
 * absent headings and leaves the repair to the author.
 */

import type { Violation } from "../gate/index.js";

/** A single section convention violation. */
export interface SectionViolation extends Violation {
	readonly kind: "section";
	/** invented: a heading not in the set. missing: a required heading absent. */
	readonly issue: "invented" | "missing";
	/** The offending heading (invented) or the absent one (missing). */
	readonly found: string;
}

const FENCE_REGEX = /```[\s\S]*?```/g;
const HEADING_REGEX = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
// Emoji presentation selector. The check mark renders with or
// without it depending on the editor; normalize it away so
// `✅` and `✅\uFE0F` compare equal against the sanctioned set.
const VARIATION_SELECTOR = /\uFE0F/g;

/** Canonicalize a heading to `<hashes> <text>` with single spacing. */
function canonical(hashes: string, text: string): string {
	return `${hashes} ${text}`.replace(VARIATION_SELECTOR, "");
}

/** Mask fenced code blocks so a `#` inside them is never a heading. */
function maskFences(body: string): string {
	return body.replace(FENCE_REGEX, (match) => " ".repeat(match.length));
}

/**
 * Find every heading in a body that is not sanctioned (invented)
 * and every sanctioned heading the body omits (missing).
 */
export function detectSectionViolations(
	body: string,
	sanctioned: readonly string[],
): SectionViolation[] {
	const sanctionedSet = new Set(
		sanctioned.map((h) => h.replace(VARIATION_SELECTOR, "")),
	);
	const masked = maskFences(body);

	const present = new Set<string>();
	const violations: SectionViolation[] = [];

	for (const match of masked.matchAll(HEADING_REGEX)) {
		const heading = canonical(match[1], match[2]);
		if (sanctionedSet.has(heading)) {
			present.add(heading);
		} else {
			violations.push({ kind: "section", issue: "invented", found: heading });
		}
	}

	for (const heading of sanctionedSet) {
		if (!present.has(heading)) {
			violations.push({ kind: "section", issue: "missing", found: heading });
		}
	}

	return violations;
}
