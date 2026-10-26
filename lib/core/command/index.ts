/**
 * Command model: a lossless, range-indexed view of a bash command
 * line, plus a flag-spec layer for understanding and a splice
 * primitive for editing.
 *
 * Public entry point. Guardians and interceptors pull from here to
 * detect, enforce and rewrite commands without reconstructing them.
 */

export type { EffectiveCwd } from "./cwd.ts";
export { effectiveCwd } from "./cwd.ts";
export type { Edit } from "./edit.ts";
export { applyEdits } from "./edit.ts";
export type { FlagDef, FlagMatch, FlagSpec } from "./flags.ts";
export { findFlag, findFlags } from "./flags.ts";
export { tokenize } from "./tokenize.ts";
export type {
	CommandLine,
	Connector,
	Heredoc,
	Quoting,
	Redirect,
	SimpleCommand,
	Span,
	Word,
} from "./types.ts";
