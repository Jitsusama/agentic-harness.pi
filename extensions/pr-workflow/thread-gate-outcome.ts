/**
 * Pure outcome reducers for thread confirmation gates.
 *
 * The interactive shell lives in `thread-gate.ts` and
 * depends on the panel runtime. These reducers stay pure
 * so tests can exercise the state machine without loading
 * the TUI stack.
 */

import type { PromptResult } from "../../lib/ui/types.js";

/** Outcome of the reply gate. The body may differ from input on redirect. */
export type ReplyGateOutcome =
	| { approved: true; body: string }
	| { approved: false; reason: string };

/** Outcome of the resolve gate. */
export type ResolveGateOutcome =
	| { approved: true }
	| { approved: false; reason: string };

/** Convert a single-prompt result into a reply decision. */
export function replyGateOutcome(
	result: PromptResult | null,
	body: string,
): ReplyGateOutcome {
	if (result === null) {
		return { approved: false, reason: "User cancelled the thread reply." };
	}
	const annotation = annotationReason(result);
	if (annotation) return annotation;
	if (result.type === "action" && result.key === "r") {
		return { approved: false, reason: "User rejected the thread reply." };
	}
	if (result.type === "redirect") {
		const next = result.note.trim();
		if (next.length === 0) {
			return { approved: false, reason: "Redirected reply was empty." };
		}
		return { approved: true, body: next };
	}
	return { approved: true, body };
}

/** Convert a single-prompt result into a resolve decision. */
export function resolveGateOutcome(
	result: PromptResult | null,
): ResolveGateOutcome {
	if (result === null) {
		return {
			approved: false,
			reason: "User cancelled the thread resolution.",
		};
	}
	const annotation = annotationReason(result);
	if (annotation) return annotation;
	if (result.type === "action" && result.key === "r") {
		return {
			approved: false,
			reason: "User rejected the thread resolution.",
		};
	}
	return { approved: true };
}

function annotationReason(
	result: PromptResult,
): { approved: false; reason: string } | null {
	if (result.type === "redirect") return null;
	const note = result.note?.trim();
	if (!note) return null;
	return { approved: false, reason: `User annotated: ${note}` };
}
