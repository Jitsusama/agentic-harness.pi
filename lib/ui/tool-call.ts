/**
 * One line saying what a tool was asked to do.
 *
 * Three surfaces wanted this and each drew it differently, which is what a reader
 * scanning a transcript actually notices: the browser tools put the tool in bold
 * and the rest in plain and dim, the review tools bolded the tool and the action
 * together so the two ran into each other, and the work tool drew the whole line
 * muted without naming the tool at all. The same event, three shapes, and the
 * cheapest one to read was the accident.
 *
 * Bold is doing one job here: it says which tool, so the eye can find the verb
 * without reading the line. Everything after it is what the verb was pointed at,
 * so it stays plain, and the subject goes dim because it is usually the longest
 * and least surprising part. That ordering is why bold on the action was wrong:
 * emphasis on both halves is emphasis on neither.
 */

import { Text } from "@earendil-works/pi-tui";

/**
 * Pi's previous component, when that is what it is.
 *
 * A renderer receives it as `unknown`, since pi cannot know what any
 * given extension returned, and every seam that threads it would
 * otherwise repeat the same narrowing. Naming it once means the reuse
 * rule has one place to change when pi's contract does.
 */
export function asText(value: unknown): Text | undefined {
	return value instanceof Text ? value : undefined;
}

/**
 * Draw this text into pi's previous component, or into a new one.
 *
 * The move every renderer makes, so it is worth one name. A renderer
 * that builds a fresh component on every pass leaves the old one in the
 * transcript beside its replacement, which reads as a ghost of the call
 * line above the finished row.
 *
 * Takes the component as `unknown` because that is how pi hands it over,
 * and because a renderer with several return paths should be able to
 * finish each of them with one call rather than a narrowing apiece.
 */
export function drawInto(reuse: unknown, text: string): Text {
	const held = asText(reuse);
	if (!held) return new Text(text, 0, 0);
	held.setText(text);
	return held;
}

/**
 * The colouring surface a renderer is handed, declared by what it uses.
 *
 * Structural rather than pi's concrete `Theme` for two reasons. Pi exports that
 * type from an internal path rather than either package root, so a renderer that
 * wants it has to reach into another package's internals. And a function that
 * needs two methods should ask for two methods: it makes a fake in a test three
 * lines long instead of a stub of a type nobody can see.
 */
export interface RenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

/** What a call line is made of. */
export interface ToolCallLine {
	/** The tool, as a reader would name it. Bold, because it is the anchor. */
	tool: string;
	/** What it was asked to do. Plain, so it reads as the tool's own word. */
	action?: string;
	/** What it was pointed at. Dim, being the longest and least surprising part. */
	subject?: string;
	/**
	 * Anything else worth one glance, each already phrased as a fragment.
	 *
	 * Dim like the subject and appended in order. For the things that are only
	 * sometimes interesting: a session that is not the default, a width sweep, a
	 * remote that is not origin.
	 */
	notes?: readonly string[];
}

/** How much of a subject to show before it stops being a line. */
const SUBJECT_LIMIT = 60;

/**
 * Shorten a subject that would otherwise take the line over.
 *
 * The marker is a real ellipsis because it marks elision, which is the one place
 * the character earns its keep over three periods.
 */
function clip(text: string, limit = SUBJECT_LIMIT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * Draw a tool call as one line: bold tool, plain action, dim everything else.
 *
 * Every field but the tool is optional, and an absent one takes no space rather
 * than leaving a gap where it would have been. A tool with nothing to say about
 * its arguments still reads as itself.
 *
 * Pass the component from the previous draw as `reuse`. Pi hands each renderer
 * what it returned last time precisely so a redraw updates one component
 * instead of stranding it beside its replacement, and a row is redrawn
 * whenever it is on screen while it is still running.
 */
export function renderToolCall(
	line: ToolCallLine,
	theme: RenderTheme,
	reuse?: Text,
): Text {
	let text = theme.fg("toolTitle", theme.bold(line.tool));

	if (line.action) text += ` ${line.action}`;
	if (line.subject) text += theme.fg("dim", ` ${clip(line.subject)}`);
	for (const note of line.notes ?? []) {
		text += theme.fg("dim", ` ${note}`);
	}

	if (!reuse) return new Text(text, 0, 0);
	reuse.setText(text);
	return reuse;
}
