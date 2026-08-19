/**
 * Splice-based attribution for gh pr/issue commands. The
 * implementation lives in agentic-harness.core (shared with the
 * Claude Code adapter); this re-exports it so existing local
 * imports keep working unchanged.
 */

export {
	type GhFooterInsertion,
	insertGhBodyFooter,
} from "@jitsusama/agentic-harness.core/attribution";
