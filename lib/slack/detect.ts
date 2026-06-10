/**
 * Slack content detection: finds markdown the Slack converter
 * cannot render as the author intended, so a gate can block and
 * point the author at the slack-guide skill. Each flagged
 * construct requires guessing the author's intent to translate
 * (which cells are headers, which lines are list items, where to
 * upload an image), so the gate refuses rather than guess. The
 * silent dialect translations in blocks.ts stay silent; this is
 * only for the cases that genuinely need the author's hand.
 *
 * Detection is deliberately conservative. A malformed list is
 * flagged only as a run of two or more lines, and a pipe table
 * only on a separator row or two adjacent pipe rows, so a lone
 * dash-led sentence or an inline `a | b` is never mistaken for
 * structure. A missed case is a missed block; a false block on
 * the high-volume Slack surface is far more corrosive.
 */

import type { Violation } from "../gate/index.js";

/** A single Slack content violation. */
export interface SlackViolation extends Violation {
	readonly kind:
		| "slack-image"
		| "slack-table"
		| "slack-list"
		| "slack-glyph-bullet";
	/** A representative offending snippet. */
	readonly found: string;
	/** A short statement of the rule, for the block message. */
	readonly rule: string;
}

const IMAGE_RULE =
	"slack-guide: Slack does not render markdown image embeds; upload the image with upload_file instead.";
const TABLE_RULE =
	"slack-guide: send tabular data through the structured table parameter, not a markdown pipe table.";
const LIST_RULE =
	"slack-guide: format lists as proper markdown (a bullet then a space, or `N.` ordinals).";
const GLYPH_LIST_RULE =
	"slack-guide: write list bullets as `- `, `* ` or `+ ` markers, not a \u2022 glyph; Slack renders glyph bullets as literal text instead of a native list.";

const FENCE_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`\n]*`/g;
const IMAGE_REGEX = /!\[[^\]]*\]\([^)\s]+\)/g;
// A markdown table separator row: pipes and dashes (with optional
// alignment colons) and nothing else, with at least one run of
// dashes. This is the unambiguous "I meant a table" signal.
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// A row that opens like a table cell: optional indent, a pipe,
// some content, another pipe.
const PIPE_ROW = /^\s*\|.*\|/;
// A line that opens an ordered list with a paren instead of the
// dot Slack needs (`1)` rather than `1.`).
const MALFORMED_ORDERED = /^\s*\d+\)\s+\S/;
// A bullet marker immediately followed by a non-space. `*` is
// left out because `*bold*` collides with it; `-` and `+` led
// runs are the unambiguous malformed-bullet case.
const MALFORMED_BULLET = /^\s*[-+]\S/;
// A line that opens with a bullet glyph, a space and content.
// The leading anchor means the glyph must start the line, so an
// inline `3 \u00b7 4` is never mistaken for a bullet, and the
// run-of-two threshold in flagLists leaves a lone glyph line
// alone. Slack renders these glyphs as literal characters rather
// than a native rich_text_list, so they need a markdown marker.
const GLYPH_BULLET = /^\s*[\u2022\u2023\u25E6\u25AA\u00b7]\s+\S/;

/** Blank out a region so its contents never match a later scan. */
function blankOut(text: string, pattern: RegExp): string {
	return text.replace(pattern, (match) => " ".repeat(match.length));
}

/**
 * Detect Slack content the converter cannot render as intended:
 * image embeds, pipe tables and malformed lists.
 */
export function detectSlackViolations(text: string): SlackViolation[] {
	// Mask code so pipes, dashes and image syntax inside it never
	// trip the scans.
	let scan = blankOut(text, FENCE_REGEX);
	scan = blankOut(scan, INLINE_CODE_REGEX);

	const violations: SlackViolation[] = [];

	for (const match of scan.matchAll(IMAGE_REGEX)) {
		violations.push({ kind: "slack-image", found: match[0], rule: IMAGE_RULE });
	}

	const lines = scan.split("\n");
	flagTables(lines, violations);
	flagLists(lines, MALFORMED_ORDERED, violations, "slack-list", LIST_RULE);
	flagLists(lines, MALFORMED_BULLET, violations, "slack-list", LIST_RULE);
	flagLists(
		lines,
		GLYPH_BULLET,
		violations,
		"slack-glyph-bullet",
		GLYPH_LIST_RULE,
	);

	return violations;
}

/**
 * Flag the first pipe table in the lines: a separator row, or a
 * run of two adjacent pipe rows. One flag is enough; the block
 * message tells the author to fix every table, so there is no
 * need to walk past the first.
 */
function flagTables(lines: string[], violations: SlackViolation[]): void {
	let runStart = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (TABLE_SEPARATOR.test(line) && line.includes("|")) {
			violations.push({
				kind: "slack-table",
				found: line.trim(),
				rule: TABLE_RULE,
			});
			return;
		}
		if (PIPE_ROW.test(line)) {
			if (runStart < 0) runStart = i;
			if (i - runStart >= 1) {
				violations.push({
					kind: "slack-table",
					found: lines[runStart].trim(),
					rule: TABLE_RULE,
				});
				return;
			}
		} else {
			runStart = -1;
		}
	}
}

/** Flag a run of two or more consecutive lines matching a marker. */
function flagLists(
	lines: string[],
	marker: RegExp,
	violations: SlackViolation[],
	kind: SlackViolation["kind"],
	rule: string,
): void {
	let runStart = -1;
	for (let i = 0; i <= lines.length; i++) {
		const matches = i < lines.length && marker.test(lines[i]);
		if (matches) {
			if (runStart < 0) runStart = i;
		} else {
			if (runStart >= 0 && i - runStart >= 2) {
				violations.push({
					kind,
					found: lines[runStart].trim(),
					rule,
				});
			}
			runStart = -1;
		}
	}
}
