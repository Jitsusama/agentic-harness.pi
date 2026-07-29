/**
 * Putting a remark under a bullet without breaking the bullet.
 *
 * Every remark worth making runs past one line: a header, a
 * blank, then the reasoning. Markdown ends a list at the first
 * blank line that is not followed by indented text, so indenting
 * only the opening line detaches the reasoning, which then reads
 * as loose prose belonging to nobody.
 *
 * This lives on its own because it was got wrong twice, in the
 * publish plan and again in the document renderer, and the second
 * one was only caught by reading the output of a real review.
 */

/** How far a continuation line sits under its bullet. */
const INDENT = "  ";

/**
 * Indent every line of a body so it stays inside its list item.
 *
 * A blank line keeps its blankness rather than being padded to
 * the indent, because padding leaves trailing whitespace on every
 * paragraph break.
 */
export function indentUnderBullet(body: string, indent = INDENT): string {
	return body
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : `${indent}${line}`))
		.join("\n");
}

/** A bullet whose body survives its own line breaks. */
export function bullet(label: string, body: string, indent = INDENT): string {
	return `- ${label}\n${indentUnderBullet(body, indent)}`;
}
