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
		`text the author asked the browser to balance were left out ` +
		`at capture.`;

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
export const TYPOGRAPHY_CAPTURE = `(() => {
	const BODY_FLOOR = ${BODY_FLOOR_CHARS};
	const MAX_TEXT = 80;

	const selectorFor = (el) => {
		const tag = el.tagName.toLowerCase();
		if (el.id) return "#" + el.id;
		const hook = el.getAttribute("data-testid");
		if (hook) return tag + '[data-testid="' + hook + '"]';
		const first = el.classList[0];
		if (first) return tag + "." + first;
		return tag;
	};

	const visualLines = (element) => {
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
		const nodes = [];
		while (walker.nextNode()) {
			if (walker.currentNode.textContent.trim()) {
				nodes.push(walker.currentNode);
			}
		}
		const range = document.createRange();
		const lines = [];
		let top = null;
		let height = 0;
		let words = 0;
		let left = Infinity;
		let right = -Infinity;
		let text = "";
		const flush = () => {
			if (words > 0) {
				lines.push({ words, width: right - left, text });
			}
			words = 0;
			left = Infinity;
			right = -Infinity;
			text = "";
		};
		for (const node of nodes) {
			const content = node.textContent;
			const matcher = /\\S+/g;
			let match = matcher.exec(content);
			while (match) {
				range.setStart(node, match.index);
				range.setEnd(node, match.index + match[0].length);
				const rect = range.getBoundingClientRect();
				if (rect.width > 0 || rect.height > 0) {
					const sameLine =
						top !== null && Math.abs(rect.top - top) <= height / 2;
					if (!sameLine) {
						flush();
						top = rect.top;
						height = rect.height;
					}
					words += 1;
					left = Math.min(left, rect.left);
					right = Math.max(right, rect.right);
					if (text.length < MAX_TEXT) {
						text = (text ? text + " " : "") + match[0];
					}
				}
				match = matcher.exec(content);
			}
		}
		flush();
		return lines;
	};

	const wrapStyle = (el) => {
		const style = getComputedStyle(el);
		return style.textWrap || style.textWrapStyle || "";
	};

	const candidates = document.querySelectorAll(
		"p, h1, h2, h3, h4, h5, h6, figcaption",
	);
	const blocks = [];
	for (const el of candidates) {
		if (el.getClientRects().length === 0) continue;
		const tag = el.tagName.toLowerCase();
		const textLength = (el.innerText || "").trim().length;
		if (textLength === 0) continue;
		// Headings matter most and are short; body text below the
		// floor has no room for a wrap worth judging.
		const heading = tag[0] === "h";
		if (!heading && textLength < BODY_FLOOR) continue;
		// The author already asked the browser to mind the wrapping.
		const wrap = wrapStyle(el);
		if (wrap.includes("balance") || wrap.includes("pretty")) continue;
		// Text inside a collapsed disclosure is not laid out.
		const details = el.closest("details");
		if (details && !details.open) continue;
		const lines = visualLines(el);
		const last = lines[lines.length - 1];
		if (!last) continue;
		blocks.push({
			selector: selectorFor(el),
			tag,
			textLength,
			containerWidth: el.clientWidth,
			lineCount: lines.length,
			lastLine: {
				words: last.words,
				width: last.width,
				text: last.text.slice(0, MAX_TEXT),
			},
		});
	}
	return blocks;
})()`;
