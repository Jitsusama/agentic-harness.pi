/**
 * Command model: a lossless, range-indexed view of a bash command
 * line, plus a flag-spec layer for understanding and a splice
 * primitive for editing.
 *
 * Public entry point. Guardians and interceptors pull from here to
 * detect, enforce and rewrite commands without reconstructing them.
 * The implementation lives in agentic-harness.core (shared with
 * the Claude Code adapter); this re-exports it so existing local
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
} from "@jitsusama/agentic-harness.core/command";
export {
	applyEdits,
	effectiveCwd,
	findFlag,
	findFlags,
	tokenize,
} from "@jitsusama/agentic-harness.core/command";
