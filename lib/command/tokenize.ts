/**
 * Tokenizer for the command model. Turns a bash command string
 * into a lossless, range-indexed CommandLine.
 */

import type { CommandLine, Quoting, SimpleCommand, Word } from "./types.js";

/** Tokenize a bash command line into a CommandLine. */
export function tokenize(source: string): CommandLine {
	const argv = scanWords(source);
	const commands: SimpleCommand[] = argv.length
		? [
				{
					span: {
						start: argv[0].span.start,
						end: argv[argv.length - 1].span.end,
					},
					assignments: [],
					argv,
					redirects: [],
				},
			]
		: [];

	return { source, commands, connectors: [], supported: true };
}

const isWhitespace = (ch: string): boolean =>
	ch === " " || ch === "\t" || ch === "\n";

/**
 * Split a command into words, treating single- and double-quoted
 * spans as part of the surrounding word so a quoted space does not
 * break the word. Each word's text is the raw source slice, so the
 * span maps back to the source exactly.
 */
function scanWords(source: string): Word[] {
	const words: Word[] = [];
	let i = 0;
	const n = source.length;

	while (i < n) {
		while (i < n && isWhitespace(source[i])) i++;
		if (i >= n) break;

		const start = i;
		let sawSingle = false;
		let sawDouble = false;

		while (i < n && !isWhitespace(source[i])) {
			const ch = source[i];
			if (ch === "'") {
				sawSingle = true;
				i++;
				while (i < n && source[i] !== "'") i++;
				if (i < n) i++;
				continue;
			}
			if (ch === '"') {
				sawDouble = true;
				i++;
				while (i < n && source[i] !== '"') i++;
				if (i < n) i++;
				continue;
			}
			i++;
		}

		words.push({
			span: { start, end: i },
			text: source.slice(start, i),
			quoting: classifyQuoting(sawSingle, sawDouble),
		});
	}

	return words;
}

/** Classify a word's quote style from which quote kinds it used. */
function classifyQuoting(sawSingle: boolean, sawDouble: boolean): Quoting {
	if (sawSingle && sawDouble) return "mixed";
	if (sawSingle) return "single";
	if (sawDouble) return "double";
	return "none";
}
