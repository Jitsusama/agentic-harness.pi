/**
 * Issue command parsing: re-exports the shared gh issue parsing
 * utilities from lib/internal/github/cli for the issue guardian.
 *
 * Editing an issue body for attribution is done by splicing in
 * place (lib/internal/github/attribution-edit), not by rebuilding
 * the command, so there is no rebuild helper here.
 */

export {
	type IssueCommand,
	isIssueCommand,
	parseIssueCommand,
} from "../../lib/internal/github/cli.js";
