/**
 * Block Kit support: laying a mrkdwn message out line by line as
 * blocks for sending (lists, quotes, code fences and paragraphs inside
 * `rich_text`, headings and dividers beside it), and whether doing so
 * renders any differently from plain mrkdwn.
 *
 * The rest of Block Kit lives beside it, one reason to change a file,
 * and is exported from here so importers keep one place to reach it:
 * the inline tokeniser in `mrkdwn-tokens.ts`, reading rich text back
 * in `rich-text-reading.ts` and the table block in `tables.ts`.
 */

import { parseMrkdwnToElements } from "./mrkdwn-tokens.ts";

export { parseMrkdwnToElements } from "./mrkdwn-tokens.ts";
export { renderRichTextCell } from "./rich-text-reading.ts";
export {
	extractCellText,
	extractTables,
	mrkdwnToCell,
	tableToBlock,
} from "./tables.ts";

/**
 * Match an ordered list line: `1. content`. Captures
 * leading whitespace, the digits and the content.
 */
const ORDERED_LIST_LINE = /^(\s*)(\d+)\.\s+(.+)$/;

/**
 * Match an unordered list line: `- content`, `* content`
 * or `+ content`. Captures leading whitespace and the
 * content (the marker itself is discarded).
 */
const UNORDERED_LIST_LINE = /^(\s*)[-*+]\s+(.+)$/;

/**
 * Match a blockquote line: `> content`. The space after
 * `>` is optional. Captures the content.
 */
const QUOTE_LINE = /^>\s?(.*)$/;

/**
 * Match a code-fence line: opening or closing triple
 * backticks. Anything after the fence (e.g. a language
 * hint) is ignored, since Slack does not render it.
 */
const FENCE_LINE = /^```/;

/**
 * Match a heading line: one to six leading `#` followed by
 * whitespace and content. Slack only has a single `header`
 * block style, so the level is captured for completeness
 * but not used: `#` and `######` render the same.
 */
const HEADING_LINE = /^(#{1,6})\s+(.+)$/;

/**
 * Match a divider line: three or more dashes, asterisks or
 * underscores on a line by themselves. Mirrors CommonMark's
 * thematic-break rule. Distinct from a list bullet because
 * a bullet always has whitespace and content after the
 * marker.
 */
const DIVIDER_LINE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Width of one indent level for nested lists, measured in
 * spaces. Two spaces or one tab counts as one level, and the
 * convention Slack's editor uses.
 */
const INDENT_WIDTH = 2;

/**
 * Inline patterns whose presence forces a `rich_text`
 * block even when no block-level structure (list, heading,
 * quote, fence, divider) is present.
 *
 * Plain mrkdwn can't faithfully render any of these:
 * markdown-style `[text](url)` shows literal brackets,
 * `**bold**` and `~~strike~~` show their markers, and
 * `#XXXXXX` hex-lookalikes get auto-rendered as colour
 * swatches that the shield in `parseMrkdwnToElements`
 * defeats only when blocks are sent.
 *
 * Non-global so `.test()` doesn't carry `lastIndex` state
 * between calls.
 */
const NEEDS_RICH_TEXT_INLINE =
	/\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+?\*\*|~~[^~\n]+?~~|#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/;

/** Maximum nesting level Slack accepts for `rich_text_list`. */
const MAX_LIST_INDENT = 8;

/**
 * Compute an indent level from a run of leading whitespace.
 *
 * Tabs count as one full level; spaces count as one level
 * per `INDENT_WIDTH` characters. The result is clamped so
 * we never exceed Slack's nesting limit.
 */
function indentLevel(whitespace: string): number {
	let spaces = 0;
	for (const ch of whitespace) {
		if (ch === "\t") spaces += INDENT_WIDTH;
		else if (ch === " ") spaces += 1;
	}
	const level = Math.floor(spaces / INDENT_WIDTH);
	return Math.min(level, MAX_LIST_INDENT);
}

/** A pending list item collected during line-by-line parsing. */
interface ListItem {
	indent: number;
	style: "ordered" | "bullet";
	content: string;
}

/**
 * Build a Block Kit `blocks` array from mrkdwn-style text.
 *
 * Walks the text line by line, producing a mix of
 * top-level blocks:
 *
 * - `rich_text` for paragraphs, lists, quotes and code
 *   fences. Inline formatting inside each line goes
 *   through {@link parseMrkdwnToElements}, which also
 *   handles markdown-style links, double-marker styles
 *   and the colour-swatch shield.
 * - `header` for `#`-prefixed lines.
 * - `divider` for thematic breaks (`---`, `***`, `___`).
 *
 * Returns the array plus a `hasStructure` flag the caller
 * can use to decide whether sending blocks (instead of
 * plain mrkdwn) actually changes how the message renders.
 */
export function mrkdwnToBlocks(text: string): {
	blocks: unknown[];
	hasStructure: boolean;
} {
	const outer: unknown[] = [];
	let rtChildren: unknown[] = [];
	let sectionLines: string[] = [];
	let listItems: ListItem[] = [];
	let quoteLines: string[] = [];
	let fenceLines: string[] = [];
	let inFence = false;
	// Inline patterns that mrkdwn can't render correctly
	// force a rich_text block even when no block-level
	// structure (list, heading, quote, fence, divider)
	// shows up. Without this, a message like
	// `[link](https://...)` would skip blocks and Slack
	// would render the brackets literally.
	let hasStructure = NEEDS_RICH_TEXT_INLINE.test(text);
	// Tracks a blank line that fell *between* two distinct
	// blocks (not inside an in-progress section). When the
	// next block opens, we emit a spacer section before it so
	// the rendered message preserves the visual gap the user
	// wrote in their input.
	let pendingSpacer = false;

	const emitSpacer = (): void => {
		if (!pendingSpacer || rtChildren.length === 0) {
			pendingSpacer = false;
			return;
		}
		rtChildren.push({
			type: "rich_text_section",
			elements: [{ type: "text", text: "\n" }],
		});
		pendingSpacer = false;
	};

	const flushSection = (): void => {
		// Trim trailing blank lines so the section ends cleanly.
		// Blank lines inside a section (between paragraphs) are
		// preserved, since Slack renders the embedded newlines as the
		// paragraph break the user wrote.
		while (
			sectionLines.length > 0 &&
			sectionLines[sectionLines.length - 1] === ""
		) {
			sectionLines.pop();
		}
		if (sectionLines.length === 0) return;
		rtChildren.push({
			type: "rich_text_section",
			elements: parseMrkdwnToElements(sectionLines.join("\n")),
		});
		sectionLines = [];
	};

	const flushList = (): void => {
		if (listItems.length === 0) return;
		hasStructure = true;
		// Group adjacent items that share both indent and style.
		// A change in either ends the current `rich_text_list`
		// and starts a new one.
		let start = 0;
		while (start < listItems.length) {
			const first = listItems[start];
			if (first === undefined) break;
			let end = start + 1;
			while (
				end < listItems.length &&
				listItems[end]?.indent === first.indent &&
				listItems[end]?.style === first.style
			) {
				end++;
			}
			const block: Record<string, unknown> = {
				type: "rich_text_list",
				style: first.style,
				elements: listItems.slice(start, end).map((item) => ({
					type: "rich_text_section",
					elements: parseMrkdwnToElements(item.content),
				})),
			};
			if (first.indent > 0) block.indent = first.indent;
			rtChildren.push(block);
			start = end;
		}
		listItems = [];
	};

	const flushQuote = (): void => {
		if (quoteLines.length === 0) return;
		hasStructure = true;
		rtChildren.push({
			type: "rich_text_quote",
			elements: parseMrkdwnToElements(quoteLines.join("\n")),
		});
		quoteLines = [];
	};

	const flushFence = (): void => {
		hasStructure = true;
		rtChildren.push({
			type: "rich_text_preformatted",
			elements: [{ type: "text", text: fenceLines.join("\n") }],
		});
		fenceLines = [];
	};

	const flushParagraph = (): void => {
		flushSection();
		flushList();
		flushQuote();
	};

	// Close the current `rich_text` block (if any) and push
	// it to the outer blocks array. Used before emitting a
	// top-level block (header or divider) that can't live
	// inside `rich_text`.
	const closeRichText = (): void => {
		flushParagraph();
		if (rtChildren.length === 0) return;
		outer.push({ type: "rich_text", elements: rtChildren });
		rtChildren = [];
		// Block-level boundaries (header, divider) carry their
		// own visual separation, so no rich_text spacer is needed
		// when we cross into one.
		pendingSpacer = false;
	};

	for (const line of text.split("\n")) {
		if (inFence) {
			if (FENCE_LINE.test(line)) {
				flushFence();
				inFence = false;
			} else {
				fenceLines.push(line);
			}
			continue;
		}

		if (FENCE_LINE.test(line)) {
			flushParagraph();
			emitSpacer();
			inFence = true;
			continue;
		}

		const heading = line.match(HEADING_LINE);
		if (heading) {
			closeRichText();
			hasStructure = true;
			outer.push({
				type: "header",
				text: { type: "plain_text", text: heading[2], emoji: true },
			});
			continue;
		}

		if (DIVIDER_LINE.test(line)) {
			closeRichText();
			hasStructure = true;
			outer.push({ type: "divider" });
			continue;
		}

		// Blank line. Three cases:
		//   1. We're inside a section. Preserve the blank as an
		//      embedded newline so paragraphs separated by a
		//      blank line render with the spacing the user
		//      wrote. Slack's editor likewise keeps blank lines
		//      inside a single `rich_text_section`.
		//   2. We're inside a list or quote. Those can't span a
		//      blank line, so end them. The blank then becomes a
		//      spacer between the list/quote and whatever comes
		//      next.
		//   3. Nothing in progress. The blank line still earns a
		//      spacer once the next block opens.
		if (line.trim().length === 0) {
			if (sectionLines.length > 0) {
				sectionLines.push("");
			} else {
				flushList();
				flushQuote();
				pendingSpacer = true;
			}
			continue;
		}

		const ordered = line.match(ORDERED_LIST_LINE);
		if (ordered) {
			const [, indent = "", , content = ""] = ordered;
			flushSection();
			flushQuote();
			emitSpacer();
			listItems.push({
				indent: indentLevel(indent),
				style: "ordered",
				content,
			});
			continue;
		}

		const unordered = line.match(UNORDERED_LIST_LINE);
		if (unordered) {
			const [, indent = "", content = ""] = unordered;
			flushSection();
			flushQuote();
			emitSpacer();
			listItems.push({
				indent: indentLevel(indent),
				style: "bullet",
				content,
			});
			continue;
		}

		const quote = line.match(QUOTE_LINE);
		if (quote) {
			flushSection();
			flushList();
			emitSpacer();
			const [, content = ""] = quote;
			quoteLines.push(content);
			continue;
		}

		// Plain paragraph line: end any list/quote run, then
		// accumulate into the current section.
		flushList();
		flushQuote();
		emitSpacer();
		sectionLines.push(line);
	}

	// End of input. An unterminated fence is still emitted,
	// dropping its content silently would be worse than
	// rendering a slightly-imperfect code block.
	if (inFence) flushFence();
	closeRichText();

	return { blocks: outer, hasStructure };
}
