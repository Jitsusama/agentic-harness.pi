/**
 * The words of a printing of the environment, each judged on its own:
 * what a word is, which is a variable's name, which could be a
 * credential, and the mark that stands where one was.
 *
 * A dump holds what no shape knows, so every bare word long and mixed
 * enough to be a credential is put out of sight, and only a variable's
 * name, a path or an address is kept. Each rule here is one a review
 * found a credential slipping past: a padding equals read as a name's, a
 * path joined to a token, words shaped as a mark around one. Each is
 * read in one pass, so hostile output costs no more than its length.
 */

/**
 * A terminal's escape: a control sequence, as a colour, its reset or a
 * cleared line; a character set chosen; a cursor saved or restored; and
 * what opens and ends a terminal's command, as a title or a link, its
 * payload read as words of its own, a link's empty field with its
 * opening. A bell ends one command and, alone, shows nothing, so it
 * splits no value either.
 */
const ESCAPE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is what this reads.
	/\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>\\]|\]\d*;;?)|\x07/g;

/** A terminal's escape, read where a scan of words stands at an ESC. */
const ESCAPE_HERE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is what this reads.
	/\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>\\]|\]\d*;;?)/y;

/** What a mark standing where a secret was opens with. */
const MARK_OPENING = "[secret scrubbed: ";

/** The words that stand where a secret was, naming what it was. */
export function scrubbedMark(kind: string): string {
	return `${MARK_OPENING}${kind}]`;
}

/**
 * `text` with every escape left unended straight before a mark dropped,
 * however many in a row, each with what a terminal reads as its middle
 * (a space, a parenthesis and the like): a terminal would read it with
 * the mark's bracket as one sequence, eating part of the mark. Read by
 * one walk back from each mark, so a run of escapes costs its length.
 */
export function unescapedMarks(text: string): string {
	if (!text.includes("\x1b")) return text;
	const pieces = text.split(MARK_OPENING);
	for (let at = 0; at < pieces.length - 1; at++) {
		const piece = pieces[at] ?? "";
		let cut = piece.length;
		for (;;) {
			let start = cut;
			while (start > 0 && MIDDLE.test(piece.charAt(start - 1))) start--;
			if (start === 0 || piece.charAt(start - 1) !== "\x1b") break;
			cut = start - 1;
		}
		pieces[at] = piece.slice(0, cut);
	}
	return pieces.join(MARK_OPENING);
}

/** What a terminal reads between an escape and the end of its sequence. */
const MIDDLE = /[ -/]/;

/** The shortest value taken as a credential's, as CREDENTIAL_VALUE has it. */
const SHORTEST_SECRET = 16;

/** Whether a value is long and mixed enough, and not a path or address. */
export function looksLikeSecret(value: string): boolean {
	return (
		value.length >= SHORTEST_SECRET &&
		/\d/.test(value) &&
		/[A-Za-z]/.test(value) &&
		!value.startsWith("/") &&
		!value.includes("://")
	);
}

/**
 * A mark standing where a secret was, on one line, its kind in words or
 * a variable's name, as `scrubbedMark` makes it, read where a scan of
 * words stands: words that only open one exempt nothing after them.
 */
const MARK_HERE = /\[secret scrubbed: [A-Za-z0-9_ ]+\]/y;

/** What ends a word: a space, a quote or an equals. */
const WORD_BREAK = /[\s'"=]/;

/** A variable's name, as a word before its equals must read. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A name as the environment's are written, in capitals with an
 * underscore, as no base64 value is: the equals after one is a name's,
 * whatever its value opens with, empty or a list's leading colon.
 */
const SHOUTED = /^(?=[^_]*_)(?=[^A-Z]*[A-Z])[A-Z0-9_]+$/;

/**
 * What follows a value's padding rather than a name's equals: nothing, a
 * second equals, a space, what ends a list, a statement or a query's
 * field, a backslash, an escape or a bell, or a quote that closes there.
 */
const PADDING_END =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape ends a value.
	/^(?:$|[=\s,;:&|\\)\]}\x1b\x07]|['"](?:$|[\s,;:&|\\)\]}\x1b\x07'"]))/;

/**
 * Whether `word`, ending at `at`, is a variable's name: it reads as one,
 * and an equals follows on its line, past any space or tab. Unless the
 * name is written as the environment's are, a value must follow straight
 * after, since a value's padding, as base64 ends in, is no name's equals.
 */
function namesAt(text: string, word: string, at: number): boolean {
	let next = at;
	while (text.charAt(next) === " " || text.charAt(next) === "\t") next++;
	if (text.charAt(next) !== "=") return false;
	const name = word.replace(ESCAPE, "");
	if (!NAME.test(name)) return false;
	return (
		SHOUTED.test(name) || !PADDING_END.test(text.slice(next + 1, next + 3))
	);
}

/** What joins a path or an address to what follows it in one word. */
const JOINER = /[\][:,;|()]/;

/** An address's host, as the piece before its port's colon reads. */
const HOST = /^\/\/[A-Za-z0-9.-]+$/;

/** A port, as an address's colon parts it from the path after it. */
const PORT = /^\d{1,5}(?=\/)/;

/** The pieces a joiner parts, a port after an address's host set aside. */
function joined(piece: string): string[] {
	return piece
		.split(JOINER)
		.map((part, at, parts) =>
			at > 0 && HOST.test(parts[at - 1] ?? "") ? part.replace(PORT, "") : part,
		);
}

/**
 * `text` with each word anywhere in it given to `replace`, read in one
 * pass. A word runs between breaks (a space, a quote, an equals), and a
 * terminal's escape within it is part of it, so a colour splits no
 * value; an escape this can't read, a cut one among them, ends it. A
 * mark already standing where a secret was is kept and ends a word, so
 * the rest of a value it cut short is read on its own. Words shaped as
 * one around what could be a credential are no mark, unless the scrub
 * put that very mark there (`marked`, the kinds it named). A variable's
 * name, before its equals, is kept (`namesAt`).
 */
export function replaceWords(
	text: string,
	replace: (word: string) => string,
	marked: ReadonlySet<string>,
): string {
	let out = "";
	let word = -1;
	const end = (at: number) => {
		if (word < 0) return;
		const found = text.slice(word, at);
		out += namesAt(text, found, at) ? found : replace(found);
		word = -1;
	};
	let at = 0;
	while (at < text.length) {
		const char = text.charAt(at);
		if (char === "[") {
			MARK_HERE.lastIndex = at;
			const mark = MARK_HERE.exec(text);
			const kind = mark?.[0].slice(MARK_OPENING.length, -1) ?? "";
			if (mark && (!looksLikeSecret(kind) || marked.has(kind))) {
				end(at);
				out += mark[0];
				at += mark[0].length;
				continue;
			}
		}
		if (char === "\x1b") {
			ESCAPE_HERE.lastIndex = at;
			const sequence = ESCAPE_HERE.exec(text);
			if (sequence) {
				if (word < 0) word = at;
				at += sequence[0].length;
				continue;
			}
		}
		if (char === "\x1b" || WORD_BREAK.test(char)) {
			end(at);
			out += char;
		} else if (word < 0) {
			word = at;
		}
		at++;
	}
	end(text.length);
	return out;
}

/**
 * A value or a word judged by what a terminal shows of it, its escapes
 * aside, and by each piece they or a joiner (a bracket, a colon, a
 * comma, a semicolon, a bar, a parenthesis) part, the port after an
 * address's host aside: put out of sight as `kind` when either could be
 * a credential,
 * so a path or an address joined to a token exempts nothing, the escapes
 * that open and close it kept; undefined when neither could. The escapes
 * are found by one walk over them.
 */
export function hidden(word: string, kind: string): string | undefined {
	const pieces = word.split(ESCAPE).flatMap(joined);
	const could =
		looksLikeSecret(word.replace(ESCAPE, "")) ||
		pieces.some((piece) => looksLikeSecret(piece));
	if (!could) return undefined;
	let opening = 0;
	let runStart = 0;
	let runEnd = -1;
	for (const sequence of word.matchAll(ESCAPE)) {
		if (sequence.index === opening) opening += sequence[0].length;
		if (sequence.index !== runEnd) runStart = sequence.index;
		runEnd = sequence.index + sequence[0].length;
	}
	const closing =
		runEnd === word.length ? Math.max(runStart, opening) : word.length;
	return `${word.slice(0, opening)}${scrubbedMark(kind)}${word.slice(closing)}`;
}
