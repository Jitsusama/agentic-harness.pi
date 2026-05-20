/**
 * Pure outcome reducer for the post gate.
 *
 * The interactive shell lives in `post-gate.ts` and
 * depends on the panel runtime. This reducer stays pure
 * so tests can exercise the state machine without
 * loading the TUI stack.
 */

import type { PromptResult } from "../../lib/ui/types.js";

/** Outcome of the post gate. The body may differ on redirect. */
export type PostGateOutcome =
	| { approved: true; body: string }
	| { approved: false; reason: string };

/**
 * Reduce a single-prompt result into a post decision.
 *
 * - `null` cancels.
 * - `r` action rejects.
 * - Any action with a non-empty annotation note rejects
 *   with the note as steering, so the agent's next turn
 *   sees the user's intent.
 * - `redirect` replaces the body when non-empty;
 *   refuses to post whitespace.
 * - Anything else approves with the original body.
 */
export function postGateOutcome(
	result: PromptResult | null,
	body: string,
): PostGateOutcome {
	if (result === null) {
		return { approved: false, reason: "User cancelled the review post." };
	}
	const annotation = annotationReason(result);
	if (annotation) return annotation;
	if (result.type === "action" && result.key === "r") {
		return { approved: false, reason: "User rejected the review post." };
	}
	if (result.type === "redirect") {
		const next = result.note.trim();
		if (next.length === 0) {
			return {
				approved: false,
				reason: "Redirected review body was empty.",
			};
		}
		return { approved: true, body: next };
	}
	return { approved: true, body };
}

function annotationReason(
	result: PromptResult,
): { approved: false; reason: string } | null {
	if (result.type === "redirect") return null;
	const note = result.note?.trim();
	if (!note) return null;
	return { approved: false, reason: `User annotated: ${note}` };
}
