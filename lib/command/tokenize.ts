/**
 * Tokenizer for the command model. Turns a bash command string
 * into a lossless, range-indexed CommandLine.
 */

import { matchHeredocs } from "../shell/parse.js";
import type {
	CommandLine,
	Connector,
	Heredoc,
	Quoting,
	SimpleCommand,
	Span,
	Word,
} from "./types.js";

/** Tokenize a bash command line into a CommandLine. */
export function tokenize(source: string): CommandLine {
	const heredocs = collectHeredocs(source);
	const { segments, connectors } = splitTopLevel(source, heredocs);
	const commands: SimpleCommand[] = [];
	for (const segment of segments) {
		const command = buildCommand(source, segment.start, segment.end, heredocs);
		if (command) commands.push(command);
	}

	return { source, commands, connectors, supported: true };
}

interface Segment {
	readonly start: number;
	readonly end: number;
}

interface HeredocInfo {
	readonly index: number;
	readonly end: number;
	readonly bodyStart: number;
	readonly bodyEnd: number;
	readonly delimiter: string;
	readonly quoted: boolean;
}

/** Locate every heredoc in the source, with body and whole spans. */
function collectHeredocs(source: string): HeredocInfo[] {
	return matchHeredocs(source).map((match) => {
		const bodyStart = source.indexOf("\n", match.index) + 1;
		return {
			index: match.index,
			end: match.index + match.length,
			bodyStart,
			bodyEnd: bodyStart + match.body.length,
			delimiter: match.delim,
			quoted: match.quoted,
		};
	});
}

/**
 * Walk the source at the top level, respecting quoting, and split
 * it at connector operators (&&, ||, ;, |, newline). Returns the
 * segment spans between operators and the connectors themselves.
 */
function splitTopLevel(
	source: string,
	heredocs: HeredocInfo[],
): {
	segments: Segment[];
	connectors: Connector[];
} {
	const segments: Segment[] = [];
	const connectors: Connector[] = [];
	let i = 0;
	let segmentStart = 0;
	const n = source.length;

	while (i < n) {
		const heredoc = heredocs.find((h) => h.index === i);
		if (heredoc) {
			i = heredoc.end;
			continue;
		}

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
	heredocs: HeredocInfo[],
): SimpleCommand | undefined {
	const heredoc = heredocs.find((h) => h.index >= start && h.index < end);
	const scanEnd = heredoc ? source.indexOf("\n", heredoc.index) : end;
	const openerWords = scanWords(source, start, scanEnd).filter(
		(word) => !heredoc || word.span.start < heredoc.index,
	);
	if (openerWords.length === 0) return undefined;

	let firstArgv = 0;
	while (
		firstArgv < openerWords.length &&
		isAssignment(openerWords[firstArgv].text)
	) {
		firstArgv++;
	}

	const assignments = openerWords.slice(0, firstArgv);
	const { argv, redirects } = extractRedirects(openerWords.slice(firstArgv));
	const spanEnd = heredoc
		? heredoc.end
		: openerWords[openerWords.length - 1].span.end;

	return {
		span: { start: openerWords[0].span.start, end: spanEnd },
		assignments,
		argv,
		redirects,
		...(heredoc ? { heredoc: toHeredoc(heredoc) } : {}),
	};
}

/** Project a HeredocInfo onto the public Heredoc shape. */
function toHeredoc(info: HeredocInfo): Heredoc {
	return {
		delimiter: info.delimiter,
		quoted: info.quoted,
		bodySpan: { start: info.bodyStart, end: info.bodyEnd },
		span: { start: info.index, end: info.end },
	};
}

const REDIRECT = /^(\d*)(>>|>|<)(&\d+)?$/;

/**
 * Pull redirects out of a word list. A redirect operator that names
 * a file descriptor duplication (2>&1) stands alone; any other
 * operator consumes the following word as its target.
 */
function extractRedirects(words: Word[]): {
	argv: Word[];
	redirects: Span[];
} {
	const argv: Word[] = [];
	const redirects: Span[] = [];

	for (let j = 0; j < words.length; j++) {
		const word = words[j];
		const match = REDIRECT.exec(word.text);
		if (!match) {
			argv.push(word);
			continue;
		}

		const hasDuplication = Boolean(match[3]);
		const target = !hasDuplication ? words[j + 1] : undefined;
		if (target) {
			redirects.push({ start: word.span.start, end: target.span.end });
			j++;
		} else {
			redirects.push({ start: word.span.start, end: word.span.end });
		}
	}

	return { argv, redirects };
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
