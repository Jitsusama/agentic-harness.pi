/**
 * Reading a tool result's text, for the renderers that have to summarize one.
 *
 * Pi hands a result's content back as a list of blocks that may be text or may be
 * an image, so reaching for `.text` does not typecheck without narrowing first.
 * Every renderResult in the package needs the same three lines, and there were six
 * copies of them in five different spellings, one narrowing with a cast that the
 * project's own rules ask people not to write. Six is well past the point where the
 * question is whether to share it.
 */

/**
 * A content block, described as far as reading its text requires.
 *
 * Structural rather than pi's own `TextContent | ImageContent`, for the same reason
 * the theme a renderer asks for is structural: this needs two optional fields, and
 * asking for them by shape keeps a test fake to one line and keeps a drawing helper
 * out of another package's type graph.
 */
export interface MaybeTextBlock {
	type?: string;
	text?: string;
}

/**
 * The first thing a result actually says, or the empty string when it says nothing.
 *
 * Scans for the first text block rather than reading position zero. The six call
 * sites this replaces all read position zero, which is the same answer whenever the
 * first block is text, and a better one when a result leads with an image and
 * explains itself underneath. An empty string for a result with no text at all,
 * because every caller is composing a line to draw and none of them can use a
 * failure.
 */
export function firstText(
	result: { content?: readonly MaybeTextBlock[] } | undefined,
): string {
	const said = result?.content?.find(
		(block) => block?.type === "text" && typeof block.text === "string",
	);
	return said?.text ?? "";
}
