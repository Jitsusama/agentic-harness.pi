/**
 * Core types for the command model: a lossless, range-indexed
 * description of a bash command line.
 *
 * Every structural element carries a byte span into the original
 * source string, so a consumer can edit by splicing exactly the
 * range it targets and leave everything else untouched.
 */

/** A half-open byte range [start, end) into the source string. */
export interface Span {
	readonly start: number;
	readonly end: number;
}

/** How a word was quoted in the source. */
export type Quoting = "none" | "single" | "double" | "mixed";

/** A single shell word (a command name, a flag, a value). */
export interface Word {
	readonly span: Span;
	readonly text: string;
	readonly quoting: Quoting;
}

/** A heredoc attached to a simple command. */
export interface Heredoc {
	readonly delimiter: string;
	readonly quoted: boolean;
	readonly bodySpan: Span;
	readonly span: Span;
}

/**
 * A redirect, and the word it names when it names one.
 *
 * The operator is kept as written, so a consumer can tell a content
 * target (`>`, `>>`) from a stream being routed (`2>`, `&>`). The target
 * is absent for a file-descriptor duplication such as `2>&1`, which names
 * no file at all.
 */
export interface Redirect {
	readonly span: Span;
	readonly operator: string;
	readonly target?: Word;
}

/** A simple command: optional env assignments, argv and redirects. */
export interface SimpleCommand {
	readonly span: Span;
	readonly assignments: Word[];
	readonly argv: Word[];
	readonly redirects: Redirect[];
	readonly heredoc?: Heredoc;
}

/** A top-level operator joining two simple commands. */
export interface Connector {
	readonly op: "&&" | "||" | ";" | "|" | "|&" | "&" | "\n";
	readonly span: Span;
}

/**
 * A tokenized command line. The commands and connectors interleave
 * in source order; `supported` is false when the line contains a
 * construct outside the grammar the model understands.
 */
export interface CommandLine {
	readonly source: string;
	readonly commands: SimpleCommand[];
	readonly connectors: Connector[];
	readonly supported: boolean;
	readonly unsupportedReason?: string;
}
