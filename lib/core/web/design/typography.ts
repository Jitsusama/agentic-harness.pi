/**
 * How text blocks end: orphans and runts, from real layout.
 *
 * A single word stranded on the last line of a paragraph or
 * heading reads as a typesetting accident, and a very short last
 * line nearly does. Neither can be judged from markup or font
 * metrics, because where the browser broke the lines is the
 * fact, so the capture reads actual line boxes word by word
 * through Range.getBoundingClientRect.
 *
 * This is taste, not conformance: nothing here fails a
 * standard, and the verdict never goes past WARN. It sits in
 * the design domain beside the inventory for the same reason
 * the inventory does: it reports what a person would want to
 * polish, and the judgment of whether it matters is theirs.
 *
 * The line-reading approach is ported from the orphans-and-runts
 * check in Carolyn McNeillie's review-page skill set, including
 * its exclusions: text the author already asked the browser to
 * balance is the browser's business, and text inside a collapsed
 * disclosure is not laid out at all.
 */

import { count } from "../../../ui/count.ts";
import { renderVerdict } from "../audit/verdict.ts";
import { pageCall } from "../page-script.ts";

/** One text-bearing block, as the page measured it. */
export interface TextBlock {
	readonly selector: string;
	readonly tag: string;
	readonly textLength: number;
	/** The width the text had to work with, in pixels. */
	readonly containerWidth: number;
	readonly lineCount: number;
	readonly lastLine: {
		readonly words: number;
		/** How wide the last line's ink actually is. */
		readonly width: number;
		/** The line itself, clipped. */
		readonly text: string;
	};
}

/** A block that ends badly, and how. */
export interface TypographyFinding {
	/** orphan: one word alone. runt: a stub of a last line. */
	readonly kind: "orphan" | "runt";
	/** Heading orphans read worst, so the caller may sort by this. */
	readonly heading: boolean;
	readonly block: TextBlock;
}

/** Body text shorter than this is skipped in the capture. */
export const BODY_FLOOR_CHARS = 80;

/** A last line of this many words or fewer can be a runt. */
export const RUNT_MAX_WORDS = 3;

/** ...when it fills less than this share of the container. */
export const RUNT_WIDTH_SHARE = 0.25;

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Judge how the captured blocks end.
 *
 * Only blocks that actually wrapped are judged: a one-line
 * heading has no last line to strand anything on.
 */
export function analyseTypography(
	blocks: readonly TextBlock[],
): readonly TypographyFinding[] {
	const findings: TypographyFinding[] = [];
	for (const block of blocks) {
		if (block.lineCount < 2) continue;
		const heading = HEADINGS.has(block.tag);
		if (block.lastLine.words === 1) {
			findings.push({ kind: "orphan", heading, block });
			continue;
		}
		if (
			block.lastLine.words <= RUNT_MAX_WORDS &&
			block.containerWidth > 0 &&
			block.lastLine.width < block.containerWidth * RUNT_WIDTH_SHARE
		) {
			findings.push({ kind: "runt", heading, block });
		}
	}
	// Headings first, orphans before runts, so the worst reads first.
	return findings.sort((a, b) => {
		if (a.heading !== b.heading) return a.heading ? -1 : 1;
		if (a.kind !== b.kind) return a.kind === "orphan" ? -1 : 1;
		return 0;
	});
}

/** Say how the page's text blocks end. */
export function renderTypography(
	blocks: readonly TextBlock[],
	findings: readonly TypographyFinding[],
): string {
	const wrapped = blocks.filter((block) => block.lineCount >= 2).length;
	const measured =
		`Measured ${count(blocks.length, "text block")}, ` +
		`${wrapped} of them wrapped. Single-line blocks have no last ` +
		`line to judge; text under ${BODY_FLOOR_CHARS} characters and ` +
		"text the author asked the browser to balance were left out " +
		"at capture.";

	if (findings.length === 0) {
		return renderVerdict(
			{
				standing: "pass",
				headline: "Every wrapped text block ends cleanly.",
				measured,
			},
			"",
		);
	}

	const orphans = findings.filter((one) => one.kind === "orphan");
	const inHeadings = findings.filter((one) => one.heading);
	const lines = findings.map((one) => {
		const what =
			one.kind === "orphan"
				? `one word alone on the last line: "${one.block.lastLine.text}"`
				: `${count(one.block.lastLine.words, "word")} on a last line ` +
					`filling ${Math.round(
						(one.block.lastLine.width / one.block.containerWidth) * 100,
					)}% of the container: "${one.block.lastLine.text}"`;
		return `  ${one.block.selector} <${one.block.tag}>  ${what}`;
	});

	return renderVerdict(
		{
			// Taste, not conformance: this never fails a page.
			standing: "warn",
			headline:
				`${count(findings.length, "text block")} of ${wrapped} ` +
				`wrapped ${wrapped === 1 ? "ends" : "end"} badly: ` +
				`${count(orphans.length, "orphan")}, ` +
				`${count(findings.length - orphans.length, "runt")}` +
				`${
					inHeadings.length === 0 ? "" : `, ${inHeadings.length} in headings`
				}.`,
			measured,
		},
		lines.join("\n"),
	);
}

/**
 * The expression that measures how text blocks wrap.
 *
 * The word walk reads each word's rectangle through a Range and
 * groups words into lines by their tops, so the lines are the
 * browser's own. Kept close to the tuned original: the fixes it
 * carries (zero-size rects from hidden text, line grouping by
 * half a line-height) were earned against real pages.
 */
export const TYPOGRAPHY_CAPTURE = pageCall(
	new URL("./typography-capture.page.js", import.meta.url),
	{ values: { BODY_FLOOR: BODY_FLOOR_CHARS } },
);
