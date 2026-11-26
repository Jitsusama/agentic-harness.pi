/**
 * A line mycelium wrote, cleaned for quoting: what it relays may come
 * from a node or a peer, so neither an escape sequence, nor the string
 * one hides, nor a character that draws as nothing is quoted as if it
 * were the reason. Sequences are dropped, not carried out, so words a
 * terminal would conceal (SGR 8), erase or write over in place are still
 * quoted, though with no escape left the model and Joel read the same
 * words. A reply quoted unread is cleaned as written, so an escape
 * still written as JSON text (\u001b) is quoted as that text. One copy,
 * for a sprout's own refusal (sprout.ts), the node's refusal of a start
 * (node.ts) or a placement (placement.ts and the quest workflow's
 * spawn), mycelium share's, a sprouted session's tie (the quest
 * workflow's sprout start) and an orchestration claim's journal line
 * (orchestrates.ts), so they can't drift apart. It cleans only what
 * these quote; other mesh code quotes a peer's words its own way.
 */

import { drawsAsNothing } from "../internal/unseen.ts";

/**
 * What ends a line in what mycelium writes, Unicode's own ends too: the
 * next line (U+0085) and the line and paragraph separators.
 */
const LINE_ENDS = /\r?\n|\r|\u0085|\u2028|\u2029/u;

/** The code point that opens a terminal's escape sequence. */
const ESCAPE_POINT = 0x1b;

/** The escape, as text. */
const ESC = String.fromCodePoint(ESCAPE_POINT);

/**
 * A terminal's string, opened by `opener` and dropped up to the first of
 * `ends`, the 7-bit string end, the next ESC, which a terminal takes as
 * ending it too, or the end of the text, since a terminal reads a string
 * on across line ends. Its body stops at nothing else, so where
 * terminals read its end differently (an 8-bit end, CAN, SUB, another
 * 8-bit control), the longer reading is the one dropped: too much is
 * dropped rather than hidden words quoted.
 */
function terminalString(opener: string, ends: readonly string[]): string {
	const ending = [...ends, `${ESC}\\\\`, `(?=${ESC})`, "$"].join("|");
	return `${opener}[^${ends.join("")}${ESC}]*(?:${ending})`;
}

/**
 * The controls a terminal carries out, or ignores (DEL), while an ESC
 * waits for the character it takes, the escape staying open: every one
 * below the space but CAN and SUB, which end it, and ESC, which opens
 * another. A line end among them still moves the line on.
 */
const WAITED_PAST = "[\\u0000-\\u0017\\u0019\\u001C-\\u001F\\u007F]*";

/** An ESC, with what a terminal reads past before the character it takes. */
const ESC_OPEN = `${ESC}${WAITED_PAST}`;

/**
 * A terminal's escape sequence, dropped whole so none of it reads as
 * text: a string (terminalString), where a title or a hyperlink's
 * address (OSC) ends at the bell too and the rest only at the string's
 * end, and one opened 7-bit ends only 7-bit, since many terminals take
 * no encoded 8-bit control as its end; a colour or a cursor move, 7-bit
 * or 8-bit; or an ESC and the character it takes. An ESC opens each
 * though controls come before that character (ESC_OPEN).
 */
const ESCAPES = new RegExp(
	[
		terminalString(`${ESC_OPEN}\\]`, ["\\u0007"]),
		terminalString(`${ESC_OPEN}[P_^X]`, []),
		terminalString("\\u009D", ["\\u0007", "\\u009C"]),
		terminalString("[\\u0090\\u0098\\u009E\\u009F]", ["\\u009C"]),
		`${ESC_OPEN}\\[[0-?]*[ -/]*[@-~]`,
		"\\u009B[0-?]*[ -/]*[@-~]",
		`${ESC_OPEN}[ -/]*[0-~]`,
	].join("|"),
	"gu",
);

/** What a terminal reads past after an ESC, at the start of a sequence. */
const WAITED_AT_START = new RegExp(`^${WAITED_PAST}`, "u");

/**
 * `text` with its escape sequences dropped (ESCAPES). The controls a
 * terminal carries out between an ESC and the character it takes are
 * kept, so a line end there still ends a line, as it does on screen.
 */
function unescaped(text: string): string {
	return text.replace(ESCAPES, (sequence) =>
		sequence.startsWith(ESC)
			? (WAITED_AT_START.exec(sequence.slice(ESC.length))?.[0] ?? "")
			: "",
	);
}

/** The control characters, a tab among them, each read as a space. */
const CONTROLS = /\p{Cc}/u;

/**
 * The last line of `text` with anything left once cleaned (shownLine),
 * a progress bar's last redraw included, so a line of only marks never
 * hides the reason above it. It's cut to `most` whole characters and
 * ended with "..." where it was cut, so a cut reason never reads as the
 * whole of it, or "" where `text` has none. Its escapes are dropped
 * from the whole of it first (ESCAPES), since a string a terminal hides
 * runs on across line ends; lines are then read from the end, so only
 * the last few are cleaned of the rest however much came before.
 */
export function lastShownLine(text: string, most: number): string {
	const lines = unescaped(text).split(LINE_ENDS);
	return cut(lastShownFrom(lines, 0), most);
}

/** What's quoted of words of which nothing shows once cleaned. */
export const NOTHING_SHOWN = "nothing that shows";

/** What joins the lines of a quote that keeps several. */
const BETWEEN_LINES = " / ";

/** What stands for the lines a quote leaves out between two it keeps. */
const LEFT_OUT = "...";

/**
 * Every line of `text` with anything left once cleaned, as lastShownLine
 * cleans them, joined by " / ", cut to `most` as it cuts. Where they
 * don't fit, the first and the last are kept and the lines between from
 * the first on while they fit, the rest standing as "...", since a
 * program puts its cause first and a hint last (clap's "error:
 * unexpected argument" above "For more information, try '--help'."),
 * and what's between can be its message (a Rust panic's below where it
 * panicked) or a cause in a chain. So no line is left out unmarked.
 */
export function shownLines(text: string, most: number): string {
	const lines = unescaped(text)
		.split(LINE_ENDS)
		.map(shownLine)
		.filter((line) => line !== "");
	const whole = lines.join(BETWEEN_LINES);
	const first = lines[0];
	const last = lines.at(-1);
	if (lines.length < 3 || first === undefined || last === undefined) {
		return cut(whole, most);
	}
	if (Array.from(whole).length <= most) return whole;
	const kept = [first];
	for (const line of lines.slice(1, -1)) {
		const tried = [...kept, line, LEFT_OUT, last].join(BETWEEN_LINES);
		if (Array.from(tried).length > most) break;
		kept.push(line);
	}
	return cut([...kept, LEFT_OUT, last].join(BETWEEN_LINES), most);
}

/** The last of `lines` from `from` on with anything left once cleaned. */
function lastShownFrom(lines: readonly string[], from: number): string {
	let line = "";
	for (let at = lines.length - 1; at >= from && line === ""; at -= 1) {
		line = shownLine(lines[at] ?? "");
	}
	return line;
}

/** `line` cut to `most` whole characters, ended with "..." where cut. */
function cut(line: string, most: number): string {
	const characters = Array.from(line);
	return characters.length > most
		? `${characters.slice(0, most).join("")}...`
		: line;
}

/**
 * A line as it shows, its escape sequences already dropped from the
 * whole text (unescaped), since dropping them again from what's left
 * could join the rest into a sequence a terminal never read. Every
 * character that draws as nothing, a format one or another the node
 * counts as unseen, is dropped. Each control left reads as a space. Its
 * backticks become plain quotes, so none reads as a command beside the
 * one the words ask to run.
 */
function shownLine(line: string): string {
	return Array.from(line)
		.filter((each) => !drawsAsNothing(each))
		.map((each) => (CONTROLS.test(each) ? " " : each))
		.join("")
		.replaceAll("`", "'")
		.trim();
}
