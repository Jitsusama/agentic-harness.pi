/**
 * Flag layer: understand a command's flags against a caller-supplied
 * spec. The core ships no flag tables; each domain passes the spec
 * for the command it owns, so knowledge of a command lives in one
 * place and is imported where needed.
 */

import type { SimpleCommand, Span, Word } from "./types.js";

/** One known flag: its canonical name, long and short forms. */
export interface FlagDef {
	readonly name: string;
	readonly long?: string;
	readonly short?: string;
	readonly takesValue: boolean;
}

/** The set of flags a caller knows about for a command. */
export interface FlagSpec {
	readonly flags: FlagDef[];
}

/** A located flag occurrence and, when it takes one, its value. */
export interface FlagMatch {
	readonly name: string;
	readonly flagSpan: Span;
	readonly value?: string;
	readonly valueSpan?: Span;
}

/** Find the first occurrence of a named flag in a command. */
export function findFlag(
	command: SimpleCommand,
	spec: FlagSpec,
	name: string,
): FlagMatch | undefined {
	const def = spec.flags.find((flag) => flag.name === name);
	if (!def) return undefined;

	const { argv } = command;
	for (let i = 0; i < argv.length; i++) {
		const match = matchAt(def, argv[i], argv[i + 1]);
		if (match) return match;
	}
	return undefined;
}

/**
 * Match one flag definition against a word and the word that
 * follows it, covering the long, long=value, short and attached
 * short forms. Returns a match, or undefined when the word is not
 * this flag.
 */
function matchAt(
	def: FlagDef,
	word: Word,
	next: Word | undefined,
): FlagMatch | undefined {
	const separateValue = (): Pick<FlagMatch, "value" | "valueSpan"> =>
		def.takesValue && next ? { value: next.text, valueSpan: next.span } : {};
	const attachedValue = (prefixLength: number): FlagMatch => ({
		name: def.name,
		flagSpan: word.span,
		value: word.text.slice(prefixLength),
		valueSpan: { start: word.span.start + prefixLength, end: word.span.end },
	});

	const long = def.long ? `--${def.long}` : undefined;
	if (long && word.text === long) {
		return { name: def.name, flagSpan: word.span, ...separateValue() };
	}
	if (long && word.text.startsWith(`${long}=`)) {
		return attachedValue(long.length + 1);
	}

	const short = def.short ? `-${def.short}` : undefined;
	if (short && word.text === short) {
		return { name: def.name, flagSpan: word.span, ...separateValue() };
	}
	if (
		short &&
		def.takesValue &&
		word.text.length > short.length &&
		word.text.startsWith(short)
	) {
		return attachedValue(short.length);
	}

	return undefined;
}
