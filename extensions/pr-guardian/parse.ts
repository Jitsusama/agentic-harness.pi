/**
 * PR command parsing: re-exports the shared gh pr parsing
 * utilities from lib/internal/github/cli for the PR guardian.
 *
 * Editing a PR body for attribution is done by splicing in place
 * (lib/internal/github/attribution-edit), not by rebuilding the
 * command, so there is no rebuild helper here.
 */

export {
	isPrCommand,
	type PrCommand,
	parsePrCommand,
} from "../../lib/internal/github/cli.js";
