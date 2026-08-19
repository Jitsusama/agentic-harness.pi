/**
 * Commit attribution trailer: formatting the Co-Authored-By line
 * the prepare-commit-msg hook appends to every commit pi drives.
 * formatModelName is host-agnostic and lives in
 * agentic-harness.core; this file's own branding ("via Pi",
 * noreply@pi.dev) is pi's, not shared.
 */

export { formatModelName } from "@jitsusama/agentic-harness.core/attribution";

import { formatModelName } from "@jitsusama/agentic-harness.core/attribution";

/** Build the Co-Authored-By trailer line for a commit. */
export function coAuthorTrailer(modelId: string | null): string {
	const modelPart = modelId
		? ` (${formatModelName(modelId)} via Pi)`
		: " via Pi";
	return `Co-Authored-By: AI${modelPart} <noreply@pi.dev>`;
}
