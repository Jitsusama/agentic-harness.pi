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

import type { Violation } from "../../gate/index.ts";
import { type DepthShape, isPartHeading } from "./shape.ts";

/** A single section convention violation. */
export interface SectionViolation extends Violation {
	readonly kind: "section";
	/**
	 * invented: a heading not in the set. missing: a required
	 * heading absent. misordered: the present sanctioned headings
	 * are not in the order the skill mandates.
	 */
	readonly issue: "invented" | "missing" | "misordered";
	/**
	 * The offending heading (invented), the absent one (missing) or
	 * the required order of the present headings (misordered).
	 */
	readonly found: string;
}

const FENCE_REGEX = /```[\s\S]*?```/g;
const HEADING_REGEX = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
// Emoji presentation selector. The check mark renders with or
// without it depending on the editor; normalize it away so
// `✅` and `✅️` compare equal against the sanctioned set.
const VARIATION_SELECTOR = /️/g;

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
 * and every sanctioned heading the body omits (missing). A part's
 * subheading under a section the depth names belongs to that section
 * and is no heading of its own; whether the change may have parts at
 * all is the shape's to say.
 */
export function detectSectionViolations(
	body: string,
	sanctioned: readonly string[],
	depth?: DepthShape,
): SectionViolation[] {
	const sanctionedSet = new Set(
		sanctioned.map((h) => h.replace(VARIATION_SELECTOR, "")),
	);
	const masked = maskFences(body);

	const present = new Set<string>();
	// The sanctioned headings in the order they first appear, so a
	// reordering can be compared against the canonical sequence.
	const presentInOrder: string[] = [];
	const violations: SectionViolation[] = [];
	let within: string | undefined;

	for (const match of masked.matchAll(HEADING_REGEX)) {
		if (isPartHeading(match[1], within, depth)) continue;
		const heading = canonical(match[1], match[2]);
		within = heading;
		if (sanctionedSet.has(heading)) {
			if (!present.has(heading)) presentInOrder.push(heading);
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

	// The skill mandates a fixed order. Compare the present
	// headings against their canonical sequence; if they differ,
	// the body is out of order even when the set is complete.
	const canonicalOrder = sanctioned
		.map((h) => h.replace(VARIATION_SELECTOR, ""))
		.filter((h) => present.has(h));
	if (presentInOrder.join("\n") !== canonicalOrder.join("\n")) {
		violations.push({
			kind: "section",
			issue: "misordered",
			found: canonicalOrder.join(" then "),
		});
	}

	return violations;
}
