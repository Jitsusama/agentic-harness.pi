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

	const unsupportedReason =
		detectUnsupported(source, heredocs) ?? detectControlFlow(commands);
	return {
		source,
		commands,
		connectors,
		supported: unsupportedReason === undefined,
		...(unsupportedReason ? { unsupportedReason } : {}),
	};
}

/**
 * Scan for constructs outside the supported grammar, ignoring
 * quoted text and heredoc bodies (where the bytes are literal or
 * user content, not command structure). Returns a reason when one
 * is found, so a consumer can fail closed on it.
 */
function detectUnsupported(
	source: string,
	heredocs: HeredocInfo[],
): string | undefined {
	let i = 0;
	const n = source.length;

	while (i < n) {
		const body = heredocs.find((h) => i >= h.bodyStart && i < h.bodyEnd);
		if (body) {
			i = body.bodyEnd;
			continue;
		}

		const ch = source[i];
		if (ch === "'" || ch === '"') {
			i = skipQuoted(source, i);
			continue;
		}
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "$" && source[i + 1] === "(") {
			return "command substitution $(...) is not supported";
		}
		if (ch === "`") {
			return "backtick command substitution is not supported";
		}
		if (ch === "(") {
			return "a subshell (...) is not supported";
		}
		if (ch === "{" && isWhitespace(source[i + 1])) {
			return "a brace group { ...; } is not supported";
		}
		i++;
	}

	return undefined;
}

const CONTROL_FLOW_KEYWORDS = new Set([
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
]);

/** Flag a command whose name is a shell control-flow keyword. */
function detectControlFlow(commands: SimpleCommand[]): string | undefined {
	for (const command of commands) {
		const name = command.argv[0]?.text;
		if (name && CONTROL_FLOW_KEYWORDS.has(name)) {
			return `shell control flow (${name}) is not supported`;
		}
	}
	return undefined;
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

		if (isContinuation(source, i)) {
			i += 2;
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

/** Whether a backslash-newline line continuation begins at i. */
function isContinuation(source: string, i: number): boolean {
	return source[i] === "\\" && source[i + 1] === "\n";
}

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
		while (i < end && (isWhitespace(source[i]) || isContinuation(source, i))) {
			i += isContinuation(source, i) ? 2 : 1;
		}
		if (i >= end) break;

		const wordStart = i;
		let sawSingle = false;
		let sawDouble = false;

		while (i < end && !isWhitespace(source[i]) && !isContinuation(source, i)) {
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
