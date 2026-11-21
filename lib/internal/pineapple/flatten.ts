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
 */

import { matchHeredocs } from "../../shell/parse.ts";

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

/** The line with its structure flattened, and what its double quotes run. */
export function flatten(source: string): Flattened {
	const bodies = matchHeredocs(source).map((match) => {
		const start = source.indexOf("\n", match.index) + 1;
		return { start, end: start + match.body.length };
	});
	const bodyAt = (at: number) =>
		bodies.find((body) => at >= body.start && at < body.end);
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
	const substituted: string[] = [];
	let text = '"';
	let at = open + 1;
	while (at < source.length && source[at] !== '"') {
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
	return {
		text: `${text}"`,
		substituted,
		end: Math.min(at + 1, source.length),
	};
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
