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
 * cleared line; a character set chosen; a cursor saved or restored; a
 * string's terminator; a terminal's whole command on one line, as a
 * title or a link, whose payload `judgedCommands` has judged already;
 * or a bell, which alone shows nothing. None splits a value, since a
 * terminal shows none of them.
 */
const ESCAPE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is what this reads.
	/\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>\\]|\]\d*;[^\x07\x1b\n]*(?:\x07|\x1b\\))|\x07/g;

/** A terminal's escape, read where a scan of words stands at an ESC. */
const ESCAPE_HERE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is what this reads.
	/\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>\\]|\]\d*;[^\x07\x1b\n]*(?:\x07|\x1b\\))/y;

/**
 * A terminal's command on one line, as ESCAPE reads one: its opening
 * (the command's number, and a link's empty field), its payload, and
 * the bell or string terminator that ends it.
 */
const COMMAND =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's command is what this reads.
	/(\x1b\]\d*;;?)([^\x07\x1b\n]*)(\x07|\x1b\\)/g;

/**
 * `text` with each terminal command's payload, a title's or a link's
 * address, given to `replace` word by word, as `replaceWords` reads
 * words: what a terminal hides, a model still reads.
 */
function judgedCommands(
	text: string,
	replace: (word: string) => string,
	marked: ReadonlySet<string>,
): string {
	if (!text.includes("\x1b]")) return text;
	return text.replace(
		COMMAND,
		(_whole: string, opening: string, payload: string, end: string) =>
			`${opening}${replaceWords(payload, replace, marked)}${end}`,
	);
}

/** What a mark standing where a secret was opens with. */
const MARK_OPENING = "[secret scrubbed: ";

/** The words that stand where a secret was, naming what it was. */
export function scrubbedMark(kind: string): string {
	return `${MARK_OPENING}${kind}]`;
}

/**
 * `text` with every escape or control sequence left unended straight
 * before a mark dropped, however many in a row, with what a terminal
 * reads as its parameters and its middle (digits, a semicolon, a space,
 * a parenthesis and the like): a terminal would read it with the mark's
 * bracket as one sequence, eating part of the mark. A string a command
 * opens, as a title's, is no sequence the bracket ends, so it stays.
 * Read by one walk back from each mark, so a run costs its length.
 */
export function unescapedMarks(text: string): string {
	if (!text.includes("\x1b")) return text;
	const pieces = text.split(MARK_OPENING);
	for (let at = 0; at < pieces.length - 1; at++) {
		const piece = pieces[at] ?? "";
		let cut = piece.length;
		for (;;) {
			let start = cut;
			while (start > 0 && WITHIN_SEQUENCE.test(piece.charAt(start - 1)))
				start--;
			if (start >= 2 && piece.slice(start - 2, start) === "\x1b[") {
				cut = start - 2;
				continue;
			}
			start = cut;
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

/**
 * What a terminal reads within a control sequence before its end: its
 * parameters and its middle, in any order a cut one leaves them, so the
 * walk back is looser than ESCAPE, which reads a whole one in order.
 */
const WITHIN_SEQUENCE = /[ -?]/;

/** The shortest value taken as a credential's, as CREDENTIAL_VALUE has it. */
const SHORTEST_SECRET = 16;

/** Whether a value is long and mixed enough, and not a path or address. */
export function looksLikeSecret(value: string): boolean {
	return (
		value.length >= SHORTEST_SECRET &&
		/\d/.test(value) &&
		/[A-Za-z]/.test(value) &&
		!value.startsWith("/") &&
		!value.startsWith("~/") &&
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
 * field, a backslash, an escape or a bell, or a quote that closes there,
 * a doubled one among them unless it ends its line or word: an empty
 * quoted value, `=""` alone, is a name's.
 */
const PADDING_END =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape ends a value.
	/^(?:$|[=\s,;:&|\\)\]}\x1b\x07]|['"](?:$|[\s,;:&|\\)\]}\x1b\x07]|['"](?!$|\s)))/;

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
		SHOUTED.test(name) || !PADDING_END.test(text.slice(next + 1, next + 4))
	);
}

/** What joins a path or an address to what follows it in one word. */
const JOINER = /[\][:,;|()]/;

/**
 * An address's port before its path, after its host (a name, or a
 * bracketed IPv6 address) and any user before an at sign.
 */
const ADDRESS_PORT =
	/(:\/\/(?:[^/@\s]*@)?(?:[\w.-]+|\[[\dA-Fa-f:.]+\])):\d{1,5}(?=\/)/g;

/** An address's user, and any password, before its host's at sign. */
const USER = /:\/\/([^/@\s]*)@/g;

/**
 * A character a user's address writes as a percent and two digits, read
 * as the one character it stands for, whose digits are none of its own.
 */
const PERCENT_ESCAPE = /%[\dA-Fa-f]{2}/g;

/** A digit, as a user's address writes one escaped. */
const PERCENT_DIGIT = /%3\d/g;

/** What parts a word into pieces: a break, or a joiner. */
const PIECE_BREAK = /[\s'"=\][:,;|()]/;

/** What a terminal's command holds, as ESCAPE reads one whole. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's command is what this reads.
const PAYLOAD = /^\x1b\]\d*;;?([^\x07\x1b\n]*)/;

/** An escape's payload: a terminal command's, or none. */
function payloadOf(sequence: string): string {
	return PAYLOAD.exec(sequence)?.[1] ?? "";
}

/** A run of a word's piece, from its text or from a command's payload. */
interface Segment {
	text: string;
	readonly payload: boolean;
}

/**
 * Whether a credential runs across a terminal command's payload in
 * `word`, read with each command as what it holds. Joined across its
 * breaks alone, as a model reads it; then in pieces a break or a joiner
 * parts, a colour within text parting none, each piece holding a
 * payload judged whole, and each run of payloads side by side joined to
 * the text touching it on either side, that text read from its last
 * slash before the run and to its first after, so a path or an address
 * just before it exempts nothing. A run is read whole, and, when text
 * follows it, cut at its last slash too, so a path opening it exempts
 * nothing either, unless the text is the name the run ends with
 * (`repeats`), as a link's text is its address's. One pass over the
 * word.
 */
function runsAcross(word: string): boolean {
	if (!word.includes("\x1b]")) return false;
	const read = word.replace(ESCAPE, payloadOf).split(WORD_BREAK);
	if (read.some((piece) => looksLikeSecret(piece))) return true;
	const pieces: Segment[][] = [[]];
	const push = (text: string, payload: boolean) => {
		const piece = pieces.at(-1) ?? [];
		const prior = piece.at(-1);
		if (!payload && prior && !prior.payload) prior.text += text;
		else piece.push({ text, payload });
	};
	const add = (text: string, payload: boolean) => {
		let from = 0;
		for (let at = 0; at <= text.length; at++) {
			const parts = at < text.length && PIECE_BREAK.test(text.charAt(at));
			if (!parts && at < text.length) continue;
			if (at > from) push(text.slice(from, at), payload);
			if (parts) pieces.push([]);
			from = at + 1;
		}
	};
	let at = 0;
	for (const sequence of word.matchAll(ESCAPE)) {
		add(word.slice(at, sequence.index).replace(ADDRESS_PORT, "$1"), false);
		add(payloadOf(sequence[0]), true);
		at = sequence.index + sequence[0].length;
	}
	add(word.slice(at).replace(ADDRESS_PORT, "$1"), false);
	const text = (segment: Segment | undefined) =>
		segment && !segment.payload ? segment.text : "";
	const across = (piece: Segment[], at: number) => {
		if (piece[at - 1]?.payload) return false;
		let end = at;
		while (piece[end + 1]?.payload) end++;
		const prior = text(piece[at - 1]);
		const after = text(piece[end + 1]);
		if (!prior && !after && end === at) return false;
		const payloads = piece
			.slice(at, end + 1)
			.map((segment) => segment.text)
			.join("");
		const slash = after.indexOf("/");
		const tail = slash < 0 ? after : after.slice(0, slash);
		const head = prior.slice(prior.lastIndexOf("/") + 1);
		if (looksLikeSecret(`${head}${payloads}${tail}`)) return true;
		if (!tail) return false;
		const run = `${prior}${payloads}`;
		const name = run.slice(run.lastIndexOf("/") + 1);
		return !repeats(tail, name) && looksLikeSecret(`${name}${tail}`);
	};
	return pieces.some(
		(piece) =>
			piece.length > 1 &&
			piece.some((segment) => segment.payload) &&
			(looksLikeSecret(piece.map((segment) => segment.text).join("")) ||
				piece.some((segment, at) => segment.payload && across(piece, at))),
	);
}

/**
 * `printed` with each terminal command's payload judged first
 * (`judgedCommands`), then each word anywhere in it given to `replace`,
 * read in one pass. A word runs between breaks (a space, a quote, an equals), and a
 * terminal's escape within it is part of it, so a colour splits no
 * value; an escape this can't read, a cut one among them, ends it. A
 * mark already standing where a secret was is kept and ends a word, so
 * the rest of a value it cut short is read on its own. Words shaped as
 * one around what could be a credential are no mark, unless the scrub
 * put that very mark there (`marked`, the kinds it named). A variable's
 * name, before its equals, is kept (`namesAt`).
 */
export function replaceWords(
	printed: string,
	replace: (word: string) => string,
	marked: ReadonlySet<string>,
): string {
	const text = judgedCommands(printed, replace, marked);
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
 * Whether a link's `text` is the `name` its address ends with, decoded,
 * or that name without its extension, so the address shows nothing the
 * text doesn't. A name holding a break is shown a word at a time, so its
 * first word stands for it. Any other shortening of it is none.
 */
function repeats(text: string, name: string): boolean {
	let plain = name;
	try {
		plain = decodeURIComponent(name);
	} catch {
		// A percent that escapes nothing: the name is read as written.
	}
	const dot = plain.lastIndexOf(".");
	const [word = ""] = plain.split(WORD_BREAK);
	return (
		text === plain ||
		(dot > 0 && text === plain.slice(0, dot)) ||
		(word !== plain && text === word)
	);
}

/**
 * Whether a value, its escapes aside, holds what could be a credential
 * before one of its equals, shaped as a name: the word pass keeps such a
 * word as a variable's name, and hides any other itself.
 */
function namesASecret(value: string): boolean {
	return value
		.replace(ESCAPE, "")
		.split(WORD_BREAK)
		.slice(0, -1)
		.some((piece) => NAME.test(piece) && looksLikeSecret(piece));
}

/**
 * A value or a word judged by what a terminal shows of it, its escapes
 * aside, and by each piece they or a joiner (a bracket, a colon, a
 * comma, a semicolon, a bar, a parenthesis) part, an address's port
 * aside, and its user's: put out of sight as `kind` when any could be a
 * credential, so a path or an address joined to a token exempts nothing,
 * the escapes that open and close it kept; undefined when none could. A
 * credential running across a terminal command's payload (`runsAcross`)
 * puts the word out of sight whole, commands and all, as does one that
 * could be a credential beside a command it would keep holding a
 * payload, so no half of it shows in a command kept; so does a value
 * holding one shaped as a name before an equals (`namesASecret`). The
 * escapes are found by one walk over them.
 */
export function hidden(word: string, kind: string): string | undefined {
	const pieces = word
		.replace(ADDRESS_PORT, "$1")
		.split(ESCAPE)
		.flatMap((piece) => piece.split(JOINER));
	const users = [...word.matchAll(USER)].map(([, user = ""]) =>
		user
			.replace(ESCAPE, "")
			.replace(PERCENT_DIGIT, "0")
			.replace(PERCENT_ESCAPE, "_"),
	);
	const could =
		looksLikeSecret(word.replace(ESCAPE, "")) ||
		[...pieces, ...users].some((piece) => looksLikeSecret(piece));
	if (!could)
		return runsAcross(word) || namesASecret(word)
			? scrubbedMark(kind)
			: undefined;
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
	const kept = `${word.slice(0, opening)}${word.slice(closing)}`;
	const holding = [...kept.matchAll(ESCAPE)].some(
		([sequence]) => payloadOf(sequence) !== "",
	);
	if (holding) return scrubbedMark(kind);
	return `${word.slice(0, opening)}${scrubbedMark(kind)}${word.slice(closing)}`;
}
