/**
 * Command model: a lossless, range-indexed view of a bash command
 * line, plus a flag-spec layer for understanding and a splice
 * primitive for editing.
 *
 * Public entry point. Guardians and interceptors pull from here to
 * detect, enforce and rewrite commands without reconstructing them.
 * The implementation lives in core (`lib/core/command`); this
 * re-exports it so existing local
 * imports keep working unchanged.
 */

export type {
	CommandLine,
	Connector,
	Edit,
	EffectiveCwd,
	FlagDef,
	FlagMatch,
	FlagSpec,
	Heredoc,
	Quoting,
	Redirect,
	SimpleCommand,
	Span,
	Word,
} from "../core/command/index.ts";
export {
	applyEdits,
	effectiveCwd,
	findFlag,
	findFlags,
	tokenize,
} from "../core/command/index.ts";
