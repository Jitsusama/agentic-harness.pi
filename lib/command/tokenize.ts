/**
 * Tokenizer for the command model. Turns a bash command string
 * into a lossless, range-indexed CommandLine.
 */

import type {
	CommandLine,
	Connector,
	Quoting,
	SimpleCommand,
	Word,
} from "./types.js";

/** Tokenize a bash command line into a CommandLine. */
export function tokenize(source: string): CommandLine {
	const { segments, connectors } = splitTopLevel(source);
	const commands: SimpleCommand[] = [];
	for (const segment of segments) {
		const command = buildCommand(source, segment.start, segment.end);
		if (command) commands.push(command);
	}

	return { source, commands, connectors, supported: true };
}

interface Segment {
	readonly start: number;
	readonly end: number;
}

/**
 * Walk the source at the top level, respecting quoting, and split
 * it at connector operators (&&, ||, ;, |, newline). Returns the
 * segment spans between operators and the connectors themselves.
 */
function splitTopLevel(source: string): {
	segments: Segment[];
	connectors: Connector[];
} {
	const segments: Segment[] = [];
	const connectors: Connector[] = [];
	let i = 0;
	let segmentStart = 0;
	const n = source.length;

	while (i < n) {
		const ch = source[i];
		if (ch === "'" || ch === '"') {
			i = skipQuoted(source, i);
			continue;
		}

		const op = connectorAt(source, i);
		if (op) {
			segments.push({ start: segmentStart, end: i });
			connectors.push({ op, span: { start: i, end: i + op.length } });
			i += op.length;
			segmentStart = i;
			continue;
		}
		i++;
	}
	segments.push({ start: segmentStart, end: n });

	return { segments, connectors };
}

/** The connector operator beginning at index i, or undefined. */
function connectorAt(source: string, i: number): Connector["op"] | undefined {
	const ch = source[i];
	if (ch === "&" && source[i + 1] === "&") return "&&";
	if (ch === "|" && source[i + 1] === "|") return "||";
	if (ch === "|") return "|";
	if (ch === ";") return ";";
	if (ch === "\n") return "\n";
	return undefined;
}

/** Build a simple command from the words in source[start, end). */
function buildCommand(
	source: string,
	start: number,
	end: number,
): SimpleCommand | undefined {
	const words = scanWords(source, start, end);
	if (words.length === 0) return undefined;

	let firstArgv = 0;
	while (firstArgv < words.length && isAssignment(words[firstArgv].text)) {
		firstArgv++;
	}

	return {
		span: { start: words[0].span.start, end: words[words.length - 1].span.end },
		assignments: words.slice(0, firstArgv),
		argv: words.slice(firstArgv),
		redirects: [],
	};
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Whether a word is a leading NAME=value env assignment. */
function isAssignment(text: string): boolean {
	return ASSIGNMENT.test(text);
}

const isWhitespace = (ch: string): boolean =>
	ch === " " || ch === "\t" || ch === "\n";

/** Index just past a quoted span beginning at the quote at i. */
function skipQuoted(source: string, i: number): number {
	const quote = source[i];
	i++;
	while (i < source.length && source[i] !== quote) i++;
	if (i < source.length) i++;
	return i;
}

/**
 * Split source[start, end) into words, treating single- and
 * double-quoted spans as part of the surrounding word so a quoted
 * space does not break the word. Each word's text is the raw source
 * slice, so the span maps back to the source exactly.
 */
function scanWords(source: string, start: number, end: number): Word[] {
	const words: Word[] = [];
	let i = start;

	while (i < end) {
		while (i < end && isWhitespace(source[i])) i++;
		if (i >= end) break;

		const wordStart = i;
		let sawSingle = false;
		let sawDouble = false;

		while (i < end && !isWhitespace(source[i])) {
			const ch = source[i];
			if (ch === "'") {
				sawSingle = true;
				i = skipQuoted(source, i);
				continue;
			}
			if (ch === '"') {
				sawDouble = true;
				i = skipQuoted(source, i);
				continue;
			}
			i++;
		}

		words.push({
			span: { start: wordStart, end: i },
			text: source.slice(wordStart, i),
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
