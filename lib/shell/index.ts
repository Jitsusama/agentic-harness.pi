/**
 * Shell command parsing utilities.
 *
 * Public entry point for analysing bash command strings. Used by
 * guardians, interceptors and any code that needs to understand
 * shell command structure. The implementation lives in
 * agentic-harness.core (shared with the Claude Code adapter); this
 * re-exports it so existing local imports keep working unchanged.
 */

export {
	extractBody,
	extractBodyFilePath,
	extractFlag,
	hasUnquotedHeredoc,
	quote,
	splitAtCommand,
	stripHeredocBodies,
	stripShellData,
	unquote,
} from "@jitsusama/agentic-harness.core/shell";
