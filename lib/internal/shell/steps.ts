/**
 * A shell command read as the steps it runs, each with its place in the
 * text and the folder it runs in, so one step can be rewritten where it
 * stands.
 *
 * Only what can be known without running anything is followed: plain
 * variables set earlier in the command, `$HOME`, `~`, and `cd`. A step
 * whose folder can't be known has none.
 */

import { resolve } from "node:path";

/** One step of a command: the text between its separators. */
export interface Step {
	/** Where it starts and ends in the command, end exclusive. */
	readonly start: number;
	readonly end: number;
	readonly text: string;
	/** It is one side of a pipe, or runs in the background. */
	readonly piped: boolean;
	/** The folder it runs in, or nothing when that can't be known. */
	readonly cwd: string | undefined;
	/** The plain variables set before it, as the shell will expand them. */
	readonly vars: ReadonlyMap<string, string>;
}

/** A word as the shell will see it, or nothing when it can't be known. */
export type Expand = (word: string) => string | undefined;

/** A separator at the top level: `;`, a newline, `&&`, `||`, `|` or `&`. */
function separatorAt(
	command: string,
	at: number,
): { readonly length: number; readonly piped: boolean } | undefined {
	const two = command.slice(at, at + 2);
	if (two === "&&" || two === "||") return { length: 2, piped: false };
	const one = command[at];
	if (one === ";" || one === "\n") return { length: 1, piped: false };
	if (one === "|") return { length: 1, piped: true };
	// `&` alone, not a redirection's `>&`, `&>` or `<&`.
	if (
		one === "&" &&
		command[at - 1] !== ">" &&
		command[at - 1] !== "<" &&
		command[at + 1] !== ">"
	) {
		return { length: 1, piped: true };
	}
	return undefined;
}

/**
 * Where each top-level step starts and ends. Quotes, `$(...)`, `(...)`
 * and `{...}` keep their separators inside. Nothing for a command
 * holding a heredoc, whose body would read as steps.
 */
function spansOf(
	command: string,
): { start: number; end: number; piped: boolean }[] | undefined {
	if (/<<-?\s*['"]?\w/.test(command)) return undefined;
	const spans: { start: number; end: number; piped: boolean }[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let depth = 0;
	let pipedBefore = false;
	for (let at = 0; at < command.length; at++) {
		const char = command[at];
		if (quote) {
			if (char === "\\" && quote === '"') at++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "\\") {
			at++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "(" || char === "{") depth++;
		else if ((char === ")" || char === "}") && depth > 0) depth--;
		if (depth > 0) continue;
		const separator = separatorAt(command, at);
		if (!separator) continue;
		spans.push({ start, end: at, piped: pipedBefore || separator.piped });
		pipedBefore = separator.piped;
		start = at + separator.length;
		at = start - 1;
	}
	spans.push({ start, end: command.length, piped: pipedBefore });
	return spans;
}

/**
 * The words of a step as the shell splits them, quotes kept, so a
 * single-quoted word is known not to expand.
 */
export function wordsOf(text: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	for (let at = 0; at < text.length; at++) {
		const char = text[at] ?? "";
		if (quote) {
			word += char;
			if (char === "\\" && quote === '"') word += text[++at] ?? "";
			else if (char === quote) quote = undefined;
			continue;
		}
		if (/\s/.test(char)) {
			if (word !== "") words.push(word);
			word = "";
			continue;
		}
		if (char === "\\") {
			word += char + (text[++at] ?? "");
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		word += char;
	}
	if (word !== "") words.push(word);
	return words;
}

/** A variable named in a word, as `$W` or `${W}`. */
const VARIABLE = /\$(?:\{(\w+)\}|(\w+))/g;

/**
 * A word expanded as the shell would with `vars`, `cwd` as `$PWD` and
 * `home` as `$HOME` and a leading `~`, its quotes taken off. Nothing
 * when it names anything else: another variable, a substitution, a
 * glob, or an escape.
 */
export function expandWith(
	vars: ReadonlyMap<string, string>,
	cwd: string | undefined,
	home: string,
): Expand {
	const known = (name: string) =>
		name === "HOME" ? home : name === "PWD" ? cwd : vars.get(name);
	return (word) => {
		let out = "";
		let rest = word;
		if (rest.startsWith("~/") || rest === "~") rest = home + rest.slice(1);
		for (const piece of rest.match(/'[^']*'|"(?:[^"\\]|\\.)*"|[^'"]+/g) ?? []) {
			if (piece.startsWith("'")) {
				out += piece.slice(1, -1);
				continue;
			}
			const inner = piece.startsWith('"') ? piece.slice(1, -1) : piece;
			if (/\$\(|`|\\|[*?[\]]/.test(inner)) return undefined;
			let unknown = false;
			out += inner.replace(VARIABLE, (_, braced, bare) => {
				const value = known(braced ?? bare);
				if (value === undefined) unknown = true;
				return value ?? "";
			});
			if (unknown || out.includes("$")) return undefined;
		}
		return out;
	};
}

/** `NAME=value`, as a step setting a variable writes it. */
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s;

/**
 * The steps of `command`, run from `cwd`, each with the folder it runs
 * in and the variables set before it. Nothing for a command holding a
 * heredoc.
 */
export function stepsOf(
	command: string,
	cwd: string,
	home: string,
): Step[] | undefined {
	const spans = spansOf(command);
	if (!spans) return undefined;
	const vars = new Map<string, string>();
	let here: string | undefined = cwd;
	const steps: Step[] = [];
	for (const span of spans) {
		const text = command.slice(span.start, span.end);
		steps.push({ ...span, text, cwd: here, vars: new Map(vars) });
		const words = wordsOf(text);
		const expand = expandWith(vars, here, home);
		const first = words[0] === "export" ? words.slice(1) : words;
		if (first.length > 0 && first.every((word) => ASSIGNMENT.test(word))) {
			for (const word of first) {
				const [, name = "", value = ""] = ASSIGNMENT.exec(word) ?? [];
				const expanded = expand(value);
				if (expanded === undefined) vars.delete(name);
				else vars.set(name, expanded);
			}
		} else if (words[0] === "cd" && !span.piped) {
			const to = words[1] === undefined ? home : expand(words[1]);
			here =
				words.length > 2 || to === undefined || here === undefined
					? undefined
					: resolve(here, to);
		} else if (words[0] === "pushd" || words[0] === "popd") {
			here = undefined;
		}
	}
	return steps;
}
