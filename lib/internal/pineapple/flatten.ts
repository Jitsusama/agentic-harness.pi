/**
 * A shell line the command model can't read, made into one it can, so
 * the write guard (writes.ts) reads each command in it word by word as
 * it reads any other, wrappers, launchers and `-c` lines included,
 * rather than guessing from patterns over the raw text.
 *
 * What makes a line unreadable is its structure: a command substitution,
 * a subshell, a brace group or a loop. None of that changes which
 * programs run, so each is turned into a break between commands and its
 * control words (`for`, `do`, `then`, `done` and the rest) are left out.
 * Quoted text and heredoc bodies are kept as they are, as data: a commit
 * message about pi starts nothing. The one exception is a substitution
 * inside double quotes, which the shell runs, so each is handed back as
 * a line of its own to read.
 *
 * Two things are undone before any line is read, readable or not, since
 * the command model knows neither: a comment, which runs nothing, so
 * its words are no command and its apostrophe opens no quote; and a
 * heredoc, whose opener line the model reads only up to the heredoc,
 * losing a pipe or a command after it. Each heredoc becomes a
 * here-string of its body, which keeps it data and keeps what follows.
 * An unquoted heredoc's body is expanded as double quotes are, so the
 * substitutions in it are handed back to read too.
 *
 * Both are found as the shell finds them, by one walk over the line
 * that knows its quotes: a `<<` inside quotes opens no heredoc, though
 * one inside a substitution in double quotes does, and a `#` starts a
 * comment only where no word is under way, so one straight after a
 * substitution or an escaped blank is part of its word.
 */

/** A line, flattened, and the substitutions its double quotes run. */
export interface Flattened {
	readonly line: string;
	readonly substituted: string[];
}

/** Words that shape a line rather than run a program. */
const CONTROL = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
	"!",
]);

/** A bare word at the start of a command, as a control word is. */
const BARE = /^[A-Za-z!]+(?=[\s;&|)]|$)/;

/** Characters that end a command, so the next word starts one. */
const BREAKS = new Set([";", "&", "|", "\n"]);

/** Part of a line, from `start` up to `end`. */
interface Span {
	readonly start: number;
	readonly end: number;
}

/**
 * A heredoc: from its `<<` (`index`) through its closing line, its body
 * running from `start` to the line before `end`'s closer.
 */
interface Heredoc extends Span {
	readonly body: string;
	readonly quoted: boolean;
	/** What follows the delimiter on its opener line, kept after it. */
	readonly openerRest: string;
	readonly index: number;
	/** Whether it opens in a substitution inside double quotes. */
	readonly nested: boolean;
}

/** A heredoc's opener: `<<` or `<<-`, then a delimiter, maybe quoted. */
const OPENER = /<<(-?)[ \t]*(['"]?)(\w+)\2/y;

/**
 * The heredoc whose `<<` is at `at`, closed by a line holding only its
 * delimiter, which a `<<-` may indent with tabs; none when it never is.
 */
function heredocAt(
	source: string,
	at: number,
	nested: boolean,
): Heredoc | undefined {
	OPENER.lastIndex = at;
	const opener = OPENER.exec(source);
	if (opener === null) return undefined;
	const [whole, dash, quote, delim] = opener;
	const rest = at + whole.length;
	const lineEnd = source.indexOf("\n", rest);
	if (lineEnd < 0) return undefined;
	const start = lineEnd + 1;
	let from = start;
	for (;;) {
		const next = source.indexOf("\n", from);
		const end = next < 0 ? source.length : next;
		const text = source.slice(from, end).trimEnd();
		if ((dash ? text.replace(/^\t+/, "") : text) === delim)
			return {
				body: from > start ? source.slice(start, from - 1) : "",
				quoted: quote !== "",
				openerRest: source.slice(rest, lineEnd),
				index: at,
				nested,
				start,
				end,
			};
		if (next < 0) return undefined;
		from = next + 1;
	}
}

/** A line's heredocs and comments, where the shell finds them. */
interface Scanned {
	readonly heredocs: Heredoc[];
	readonly comments: Span[];
}

/**
 * Walk a line as the shell reads it, for its heredocs and comments. A
 * word is under way after any character but a blank or an operator, and
 * after a substitution's `)`, which ends no word as a subshell's does.
 */
function scan(source: string): Scanned {
	const heredocs: Heredoc[] = [];
	const comments: Span[] = [];
	const bodyAt = (at: number) =>
		heredocs.find((heredoc) => at >= heredoc.start && at < heredoc.end);

	/**
	 * Commands from `at` to the `)` ending them when `nested` in a
	 * substitution inside double quotes, or to the end.
	 */
	const commands = (from: number, nested: boolean): number => {
		// Whether each parenthesis open opened a substitution.
		const parens: boolean[] = [];
		let word = false;
		let at = from;
		while (at < source.length) {
			const body = bodyAt(at);
			const char = source[at] ?? "";
			if (body) {
				at = body.end;
				word = false;
			} else if (char === "\\") {
				at += 2;
				word = true;
			} else if (char === "'" || char === "`") {
				const close = source.indexOf(char, at + 1);
				at = close < 0 ? source.length : close + 1;
				word = true;
			} else if (char === '"') {
				at = quoted(at + 1);
				word = true;
			} else if (char === "#" && !word) {
				const close = source.indexOf("\n", at);
				const end = close < 0 ? source.length : close;
				comments.push({ start: at, end });
				at = end;
			} else if (source.startsWith("<<", at) && source[at + 2] !== "<") {
				const heredoc = heredocAt(source, at, nested);
				if (heredoc) heredocs.push(heredoc);
				at += 2;
				word = false;
			} else if (char === "(") {
				parens.push(/[$<>]/.test(source[at - 1] ?? ""));
				at += 1;
				word = false;
			} else if (char === ")") {
				if (parens.length === 0 && nested) return at;
				word = parens.pop() ?? false;
				at += 1;
			} else {
				word = !/[\s;&|<>]/.test(char);
				at += 1;
			}
		}
		return at;
	};

	/** A double-quoted string from past its quote, to past its close. */
	const quoted = (from: number): number => {
		let at = from;
		while (at < source.length && source[at] !== '"') {
			const char = source[at];
			if (char === "\\") at += 2;
			else if (char === "$" && source[at + 1] === "(")
				at = commands(at + 2, true) + 1;
			else if (char === "`") {
				const close = source.indexOf("`", at + 1);
				at = close < 0 ? source.length : close + 1;
			} else at += 1;
		}
		return Math.min(at + 1, source.length);
	};

	commands(0, false);
	return { heredocs, comments };
}

/** Where each heredoc's body is in a line, to be passed over as data. */
function bodiesOf(source: string): (at: number) => Span | undefined {
	const { heredocs } = scan(source);
	return (at) =>
		heredocs.find((heredoc) => at >= heredoc.start && at < heredoc.end);
}

/**
 * The line without its comments: a `#` starting a word outside quotes,
 * to the end of its line, outside a heredoc's body.
 */
export function uncommented(source: string): string {
	let line = "";
	let at = 0;
	for (const comment of scan(source).comments) {
		line += source.slice(at, comment.start);
		at = comment.end;
	}
	return line + source.slice(at);
}

/**
 * The line with each heredoc made a here-string of its body, quoted as
 * data, and the rest of its opener line kept after it. An apostrophe in
 * the body is closed, double-quoted and reopened, since the command
 * model reads no backslash escape outside quotes. That can't be read
 * inside double quotes, so a heredoc in a substitution there is left
 * bodiless: what the substitution runs is read from the line as it was
 * (see {@link flatten}), where the heredoc is made a here-string again.
 */
export function inlined(source: string): string {
	let line = source;
	for (const heredoc of scan(source).heredocs.reverse()) {
		const body = heredoc.nested
			? "x"
			: `'${heredoc.body.replaceAll("'", `'"'"'`)}'`;
		line =
			line.slice(0, heredoc.index) +
			`<<< ${body}${heredoc.openerRest}` +
			line.slice(heredoc.end);
	}
	return line;
}

/**
 * What each unquoted heredoc's body runs: the substitutions in it, which
 * the shell expands as it does in double quotes, though a `"` in a body
 * is only a character.
 */
export function heredocRuns(source: string): string[] {
	return scan(source)
		.heredocs.filter((heredoc) => !heredoc.quoted)
		.flatMap(
			(heredoc) =>
				expanded(
					heredoc.body,
					0,
					() => undefined,
					() => false,
				).substituted,
		);
}

/** The line with its structure flattened, and what its double quotes run. */
export function flatten(source: string): Flattened {
	const bodyAt = bodiesOf(source);
	const substituted: string[] = [];
	let line = "";
	let at = 0;
	let starts = true;
	while (at < source.length) {
		const body = bodyAt(at);
		if (body) {
			line += source.slice(at, body.end);
			at = body.end;
			continue;
		}
		const char = source[at] ?? "";
		const next = source[at + 1];
		if (char === "\\") {
			line += source.slice(at, at + 2);
			at += 2;
			starts = false;
		} else if (char === "'") {
			const end = source.indexOf("'", at + 1);
			const close = end < 0 ? source.length : end + 1;
			line += source.slice(at, close);
			at = close;
			starts = false;
		} else if (char === '"') {
			const quoted = doubleQuoted(source, at, bodyAt);
			line += quoted.text;
			substituted.push(...quoted.substituted);
			at = quoted.end;
			starts = false;
		} else if (char === "$" && next === "{") {
			const end = source.indexOf("}", at);
			const close = end < 0 ? source.length : end + 1;
			line += source.slice(at, close);
			at = close;
			starts = false;
		} else if (char === "$" && next === "(") {
			line += "\n";
			at += 2;
			starts = true;
		} else if (
			char === "`" ||
			char === "(" ||
			char === ")" ||
			(char === "{" && /\s/.test(next ?? "")) ||
			(char === "}" && starts)
		) {
			line += "\n";
			at += 1;
			starts = true;
		} else if (BREAKS.has(char)) {
			line += char;
			at += 1;
			starts = true;
		} else if (/\s/.test(char)) {
			line += char;
			at += 1;
		} else if (starts) {
			const word = BARE.exec(source.slice(at))?.[0];
			if (word !== undefined && CONTROL.has(word)) {
				line += " ";
				at += word.length;
			} else {
				starts = false;
			}
		} else {
			line += char;
			at += 1;
		}
	}
	return { line, substituted };
}

/**
 * A double-quoted string from its opening quote: its text, with each
 * substitution in it left as a placeholder word, what each substitution
 * runs, and where the string ends.
 */
function doubleQuoted(
	source: string,
	open: number,
	bodyAt: (at: number) => { end: number } | undefined,
): { text: string; substituted: string[]; end: number } {
	const inner = expanded(source, open + 1, bodyAt, (char) => char === '"');
	return {
		text: `"${inner.text}"`,
		substituted: inner.substituted,
		end: Math.min(inner.end + 1, source.length),
	};
}

/**
 * Text the shell expands, from `from` to where `closes` says it ends:
 * its text, with each substitution in it left as a placeholder word,
 * what each substitution runs, and where the text ends.
 */
function expanded(
	source: string,
	from: number,
	bodyAt: (at: number) => { end: number } | undefined,
	closes: (char: string) => boolean,
): { text: string; substituted: string[]; end: number } {
	const substituted: string[] = [];
	let text = "";
	let at = from;
	while (at < source.length && !closes(source[at] ?? "")) {
		const char = source[at] ?? "";
		if (char === "\\") {
			text += source.slice(at, at + 2);
			at += 2;
		} else if (char === "$" && source[at + 1] === "(") {
			const close = closing(source, at + 1, bodyAt);
			substituted.push(source.slice(at + 2, close));
			text += "x";
			at = close + 1;
		} else if (char === "`") {
			const end = source.indexOf("`", at + 1);
			const close = end < 0 ? source.length : end;
			substituted.push(source.slice(at + 1, close));
			text += "x";
			at = close + 1;
		} else {
			text += char;
			at += 1;
		}
	}
	return { text, substituted, end: at };
}

/**
 * Where the parenthesis opened at `open` closes, past quotes and heredoc
 * bodies, or the end of the line when it never does.
 */
function closing(
	source: string,
	open: number,
	bodyAt: (at: number) => { end: number } | undefined,
): number {
	let depth = 0;
	let at = open;
	while (at < source.length) {
		const body = bodyAt(at);
		if (body) {
			at = body.end;
			continue;
		}
		const char = source[at];
		if (char === "\\") at += 2;
		else if (char === "'" || char === '"') {
			const end = source.indexOf(char, at + 1);
			at = end < 0 ? source.length : end + 1;
		} else {
			if (char === "(") depth += 1;
			if (char === ")") {
				depth -= 1;
				if (depth === 0) return at;
			}
			at += 1;
		}
	}
	return source.length;
}
