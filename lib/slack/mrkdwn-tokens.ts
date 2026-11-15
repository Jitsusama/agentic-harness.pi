/**
 * The inline mrkdwn tokeniser: a line of Slack mrkdwn, or the markdown
 * agents write instead, turned into Block Kit's rich text elements for
 * sending. It changes when Slack's inline syntax does, or when another
 * habit of the people and agents writing to it needs reading.
 */

/** A Block Kit inline element within a rich_text_section. */
export interface RichTextElement {
	type: string;
	text?: string;
	url?: string;
	style?: {
		bold?: boolean;
		italic?: boolean;
		strike?: boolean;
		code?: boolean;
	};
	user_id?: string;
	channel_id?: string;
	range?: string;
	name?: string;
}

/**
 * Characters that signal potential mrkdwn formatting.
 *
 * Used as a fast pre-check: if a string contains none of
 * these, it's plain text and can skip tokenising.
 */
const FORMATTING_CHARS = /[<`*_~:[#]/;

/**
 * Angle-bracket pattern: matches Slack's `<...>` syntax for
 * links, mentions, channels and broadcasts.
 */
const ANGLE_BRACKET = /<([^>]+)>/g;

/**
 * Backtick pattern: matches inline code spans.
 */
const BACKTICK = /`([^`]+)`/g;

/**
 * Markdown-style link pattern: `[text](url)`. Many agents
 * (and humans copy-pasting from anywhere) write links this
 * way instead of Slack's native `<url|text>` syntax. Without
 * conversion they render as literal brackets and parens.
 */
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Inline style patterns with word-boundary rules.
 *
 * Opening marker must be preceded by whitespace or
 * start-of-string. Closing marker must be followed by
 * whitespace, punctuation, or end-of-string. Content
 * between markers must be non-empty and not contain the
 * marker character.
 */
const BOLD = /(^|(?<=\s))\*([^*]+)\*(?=\s|[.,;:!?)}\]]|$)/g;
const ITALIC = /(^|(?<=\s))_([^_]+)_(?=\s|[.,;:!?)}\]]|$)/g;
const STRIKE = /(^|(?<=\s))~([^~]+)~(?=\s|[.,;:!?)}\]]|$)/g;

/**
 * Markdown-style double-marker patterns. Agents reflexively
 * write `**bold**` and `~~strike~~` even when targeting
 * Slack mrkdwn, where those would render with the marker
 * characters visible. We accept them as alternatives.
 */
const MARKDOWN_BOLD = /\*\*([^*\n]+?)\*\*/g;
const MARKDOWN_STRIKE = /~~([^~\n]+?)~~/g;

/**
 * Emoji shortcode pattern: `:name:` where name can contain
 * letters, numbers, underscores, hyphens and plus signs.
 */
const EMOJI = /:([a-z0-9_+-]+):/g;

/**
 * Hex-colour-lookalike pattern: `#` followed by 3, 4, 6 or
 * 8 hex digits with no alphanumeric character after. Slack
 * auto-renders these as colour swatches in plain mrkdwn,
 * which catches PR numbers like `#675891` (six digits = a
 * valid hex code). Splitting the `#` from the digits across
 * two adjacent text elements defeats the swatch detector
 * while rendering identically.
 */
const HEX_COLOR_LIKE =
	/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;

/** A token found during mrkdwn scanning. */
interface Token {
	/** Start index in the original string. */
	start: number;
	/** End index (exclusive). */
	end: number;
	/**
	 * The Block Kit elements this token produces. Most tokens
	 * yield a single element; the colour-swatch shield emits
	 * two so Slack's auto-detector can't see a single hex run.
	 */
	elements: RichTextElement[];
}

/**
 * Whether a string holds any character that could start mrkdwn
 * formatting. A string that doesn't is plain text, and needs no
 * tokenising.
 */
export function mayHoldFormatting(text: string): boolean {
	return FORMATTING_CHARS.test(text);
}

/**
 * Parse an angle-bracket expression into a Block Kit element.
 *
 * Handles user mentions, broadcasts, channel links, and URL
 * links, all of which use Slack's `<...>` internal format.
 */
function parseAngleBracket(content: string): RichTextElement {
	// User mention: <@U123> or <@U123|display.name>
	if (content.startsWith("@")) {
		const pipeIdx = content.indexOf("|");
		const userId = pipeIdx > 0 ? content.slice(1, pipeIdx) : content.slice(1);
		return { type: "user", user_id: userId };
	}

	// Broadcast: <!here>, <!channel>, <!everyone>
	if (content.startsWith("!")) {
		const pipeIdx = content.indexOf("|");
		const range = pipeIdx > 0 ? content.slice(1, pipeIdx) : content.slice(1);
		return { type: "broadcast", range };
	}

	// Channel link: <#C123> or <#C123|channel-name>
	if (content.startsWith("#")) {
		const pipeIdx = content.indexOf("|");
		const channelId =
			pipeIdx > 0 ? content.slice(1, pipeIdx) : content.slice(1);
		return { type: "channel", channel_id: channelId };
	}

	// URL link: <url|text> or <url>
	const pipeIdx = content.indexOf("|");
	if (pipeIdx > 0) {
		return {
			type: "link",
			url: content.slice(0, pipeIdx),
			text: content.slice(pipeIdx + 1),
		};
	}
	return { type: "link", url: content };
}

/**
 * Tokenise a mrkdwn string into Block Kit inline elements.
 *
 * Scans left to right, matching patterns in priority order:
 * angle brackets (unambiguous), backticks, then inline
 * styles with word-boundary rules. Plain text between
 * patterns becomes `text` elements. Adjacent plain segments
 * are merged.
 */
export function parseMrkdwnToElements(text: string): RichTextElement[] {
	if (!text) return [];

	// Collect all tokens from all pattern types.
	const tokens: Token[] = [];

	// 1. Angle-bracket patterns (highest priority, being unambiguous
	//    Slack-internal syntax).
	for (const match of text.matchAll(ANGLE_BRACKET)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [parseAngleBracket(match[1])],
		});
	}

	// 2. Markdown-style links. Higher priority than backticks
	//    so a link's display text can contain backticks.
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "link", url: match[2], text: match[1] }],
		});
	}

	// 3. Backtick code spans.
	for (const match of text.matchAll(BACKTICK)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[1], style: { code: true } }],
		});
	}

	// 4. Emoji shortcodes.
	for (const match of text.matchAll(EMOJI)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "emoji", name: match[1] }],
		});
	}

	// 5. Markdown-style double-marker styles. Must precede
	//    the single-marker patterns so `**bold**` doesn't get
	//    mis-tokenised as `*` then `bold` then `*`.
	for (const match of text.matchAll(MARKDOWN_BOLD)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[1], style: { bold: true } }],
		});
	}
	for (const match of text.matchAll(MARKDOWN_STRIKE)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[1], style: { strike: true } }],
		});
	}

	// 6. Slack-native single-marker inline styles.
	for (const match of text.matchAll(BOLD)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[2], style: { bold: true } }],
		});
	}
	for (const match of text.matchAll(ITALIC)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[2], style: { italic: true } }],
		});
	}
	for (const match of text.matchAll(STRIKE)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [{ type: "text", text: match[2], style: { strike: true } }],
		});
	}

	// 7. Hex-colour-lookalike shield (lowest priority, since it only
	//    fires when no other pattern claims the range). Emits
	//    two adjacent text elements so the rendered output is
	//    identical but Slack's swatch detector sees two pieces
	//    instead of one hex run.
	for (const match of text.matchAll(HEX_COLOR_LIKE)) {
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			elements: [
				{ type: "text", text: "#" },
				{ type: "text", text: match[1] },
			],
		});
	}

	// Sort by start position. For overlaps, higher-priority
	// tokens (earlier in the list) take precedence since we
	// skip tokens that overlap with already-consumed ranges.
	tokens.sort((a, b) => a.start - b.start);

	// Walk the string, emitting elements for tokens and
	// plain text for gaps.
	const elements: RichTextElement[] = [];
	let cursor = 0;

	for (const token of tokens) {
		// Skip tokens that overlap with already-consumed text.
		if (token.start < cursor) continue;

		// Emit plain text before this token.
		if (token.start > cursor) {
			const plain = text.slice(cursor, token.start);
			if (plain) pushText(elements, plain);
		}

		for (const el of token.elements) elements.push(el);
		cursor = token.end;
	}

	// Emit any trailing plain text.
	if (cursor < text.length) {
		const plain = text.slice(cursor);
		if (plain) pushText(elements, plain);
	}

	return elements;
}

/**
 * Append a plain text element, merging with the previous
 * element if it's also unstyled plain text.
 */
function pushText(elements: RichTextElement[], text: string): void {
	const last = elements[elements.length - 1];
	if (last?.type === "text" && !last.style) {
		last.text = (last.text ?? "") + text;
	} else {
		elements.push({ type: "text", text });
	}
}
