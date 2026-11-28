/**
 * A line mycelium wrote, cleaned for quoting: what it relays may come
 * from a node or a peer, so neither an escape sequence, nor the string
 * one hides, nor a character that draws as nothing is quoted as if it
 * were the reason. Sequences are dropped, not carried out, so words a
 * terminal would conceal (SGR 8) or erase are still quoted, and of a
 * line written over in place (REDRAW) its first and last drawing are, so
 * with no escape left the model and Joel read the same words. A reply quoted unread is cleaned as written, so an escape
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
 * next line (U+0085) and the line and paragraph separators. A carriage
 * return alone ends no line: it draws the line again in place (REDRAW).
 */
const LINE_ENDS = /\r?\n|\u0085|\u2028|\u2029/u;

/** What draws a line again in place, as a progress bar does. */
const REDRAW = "\r";

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
const OPENED_BY_ESC = [
	terminalString(`${ESC_OPEN}\\]`, ["\\u0007"]),
	terminalString(`${ESC_OPEN}[P_^X]`, []),
	`${ESC_OPEN}\\[[0-?]*[ -/]*[@-~]`,
	`${ESC_OPEN}[ -/]*[0-~]`,
];
const OPENED_8_BIT = [
	terminalString("\\u009D", ["\\u0007", "\\u009C"]),
	terminalString("[\\u0090\\u0098\\u009E\\u009F]", ["\\u009C"]),
	"\\u009B[0-?]*[ -/]*[@-~]",
];
const ESCAPES = new RegExp([...OPENED_BY_ESC, ...OPENED_8_BIT].join("|"), "gu");

/**
 * The sequences an ESC opens and the controls below the space, written
 * before or after JSON on its line, as a colour and its reset are. JSON
 * can hold neither as written, so dropping them from its ends never
 * changes JSON there; one within stays, so a line JSON can't read is
 * never made to read as JSON. An 8-bit control, which a JSON string may
 * hold, is never dropped. One at a time, matched where the line is read
 * (sticky), never repeated with a `+` or anchored at the end, since
 * there its overlapping alternatives (ESC ] opens a string and is an
 * ESC with the character it takes) were tried from every start, and a
 * line of a hundred bytes held the event loop for hours.
 */
const AROUND_ONE = new RegExp(
	[...OPENED_BY_ESC, "[\\u0000-\\u001F\\u007F]"].join("|"),
	"uy",
);

/**
 * `line` with what's around JSON (AROUND_ONE) dropped from both its ends, read once
 * from its start as a terminal reads it: each sequence or control is
 * taken whole where it starts, and anything else is a character of what
 * stays, so what's kept runs from the first such character to the last.
 */
function aroundDropped(line: string): string {
	let at = 0;
	let from = -1;
	let to = 0;
	while (at < line.length) {
		AROUND_ONE.lastIndex = at;
		const around = AROUND_ONE.exec(line)?.[0] ?? "";
		if (around !== "") {
			at += around.length;
			continue;
		}
		if (from < 0) from = at;
		at += (line.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
		to = at;
	}
	return from < 0 ? "" : line.slice(from, to);
}

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
 * The node's reply in what mycelium wrote on stdout: its last line that
 * shows anything, as written, where that's JSON, else none. So a line of
 * escapes alone after it, a colour reset say, never hides it, nor does
 * an escape or a progress bar's redraw on its line: where the line as
 * written isn't JSON, its last redraw that shows is read with what an ESC opens and
 * controls dropped from its ends (aroundDropped), which can't change JSON.
 * It's otherwise never
 * cleaned to be parsed, since cleaning rewrites what it keeps (a control
 * to a space, a backtick to a quote), so a reply that wasn't JSON could
 * read as started or refused, and words to join a start by could change.
 */
export function replyIn(stdout: string): string | undefined {
	const lines = stdout.split("\n");
	for (let at = lines.length - 1; at >= 0; at -= 1) {
		const line = (lines[at] ?? "").trim();
		if (shownLines(line, 1) === "") continue;
		if (isJson(line)) return line;
		const redraws = line
			.split(REDRAW)
			.filter((each) => shownLines(each, 1) !== "");
		const drawn = aroundDropped(redraws.at(-1) ?? "").trim();
		return isJson(drawn) ? drawn : undefined;
	}
	return undefined;
}

/** Whether `line` parses as JSON. */
function isJson(line: string): boolean {
	if (line === "") return false;
	try {
		JSON.parse(line);
		return true;
	} catch {
		// Not JSON, so no reply.
		return false;
	}
}

/** What's quoted of words of which nothing shows once cleaned. */
export const NOTHING_SHOWN = "nothing that shows";

/** What joins the lines of a quote that keeps several. */
const BETWEEN_LINES = " / ";

/** What stands for the lines a quote leaves out between two it keeps. */
const LEFT_OUT = "...";

/**
 * Every line of `text` with anything left once cleaned (shownLine), each
 * read as it's drawn again in place (redrawn), joined by " / ", and cut
 * to `most` whole characters, ended with "..." where cut, so a cut
 * reason never reads as the whole of it; or "" where none shows. Its
 * escapes are dropped from the whole of it first (ESCAPES), since a
 * string a terminal hides runs on across line ends. Where they
 * don't fit, the first and the last are kept and the lines between from
 * the first on while they fit, the rest standing as "...", since a
 * program puts its cause first and a hint last (clap's "error:
 * unexpected argument" above "For more information, try '--help'."),
 * and what's between can be its message (a Rust panic's below where it
 * panicked) or a cause in a chain. Where the first and the last alone
 * don't fit, each is cut to a share of `most` (bothCut). So no line is
 * left out unmarked, and neither end is lost to the other.
 */
export function shownLines(text: string, most: number): string {
	const lines = unescaped(text).split(LINE_ENDS).flatMap(redrawn);
	const whole = lines.join(BETWEEN_LINES);
	const first = lines[0];
	const last = lines.at(-1);
	if (Array.from(whole).length <= most) return whole;
	if (lines.length < 2 || first === undefined || last === undefined) {
		return cut(whole, most);
	}
	const between = lines.slice(1, -1);
	const gap = between.length > 0 ? [LEFT_OUT] : [];
	const ends = [first, ...gap, last].join(BETWEEN_LINES);
	if (Array.from(ends).length > most) return bothCut(first, last, gap, most);
	const kept = [first];
	for (const line of between) {
		const tried = [...kept, line, LEFT_OUT, last].join(BETWEEN_LINES);
		if (Array.from(tried).length > most) break;
		kept.push(line);
	}
	// A redraw's own "..." kept last already says drawings are left out.
	const gapKept = kept.at(-1) === LEFT_OUT ? [] : [LEFT_OUT];
	return [...kept, ...gapKept, last].join(BETWEEN_LINES);
}

/**
 * The first and the last line, with `gap` ("..." or nothing) between,
 * each cut to its share of what `most` leaves once they're joined: the
 * last gets half, or more where the first needs less, so a short cause
 * keeps its whole and a long one never takes the hint's room.
 */
function bothCut(
	first: string,
	last: string,
	gap: readonly string[],
	most: number,
): string {
	const joins = Array.from(["", ...gap, ""].join(BETWEEN_LINES)).length;
	const room = most - joins;
	if (room < 2) return cut([first, ...gap, last].join(BETWEEN_LINES), most);
	const firstLength = Array.from(first).length;
	const lastRoom = Math.min(
		Array.from(last).length,
		Math.max(Math.ceil(room / 2), room - firstLength),
	);
	return [cut(first, room - lastRoom), ...gap, cut(last, lastRoom)].join(
		BETWEEN_LINES,
	);
}

/**
 * A line drawn again in place (REDRAW), as the lines a quote keeps: its
 * first drawing and its last with anything left once cleaned
 * (shownLine), with "..." between where drawings between are left out,
 * or none where nothing shows. Each is a line of its own to shownLines,
 * so one cut to fit keeps the last drawing as it keeps a last line. So a
 * progress bar never fills a quote's room or pushes a cause out, and
 * neither words a cause leads with nor words a peer relays after them
 * are lost unmarked.
 */
function redrawn(line: string): string[] {
	const drawn = line
		.split(REDRAW)
		.map(shownLine)
		.filter((each) => each !== "");
	const first = drawn[0];
	const last = drawn.at(-1);
	if (first === undefined || last === undefined) return [];
	if (drawn.length === 1) return [first];
	return drawn.length > 2 ? [first, LEFT_OUT, last] : [first, last];
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
