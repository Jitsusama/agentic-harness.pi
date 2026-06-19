/**
 * Command model: a lossless, range-indexed view of a bash command
 * line, plus a flag-spec layer for understanding and a splice
 * primitive for editing.
 *
 * Public entry point. Guardians and interceptors pull from here to
 * detect, enforce and rewrite commands without reconstructing them.
 */

export type { EffectiveCwd } from "./cwd.js";
export { effectiveCwd } from "./cwd.js";
export type { Edit } from "./edit.js";
export { applyEdits } from "./edit.js";
export type { FlagDef, FlagMatch, FlagSpec } from "./flags.js";
export { findFlag } from "./flags.js";
export { tokenize } from "./tokenize.js";
export type {
	CommandLine,
	Connector,
	Heredoc,
	Quoting,
	SimpleCommand,
	Span,
	Word,
} from "./types.js";
