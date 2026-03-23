/**
 * Plan gate: approval panel for an implementation plan.
 *
 * The LLM proposes a plan (what to change and why) before
 * touching any files. The user can approve, explore deeper
 * via plan mode, redirect with feedback, or cancel.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../../lib/ui/content-renderer.js";
import { promptSingle } from "../../lib/ui/panel.js";

/** Result from the plan gate. */
export type PlanGateResult =
	| { action: "approve"; note?: string }
	| { action: "explore"; note?: string }
	| { action: "redirect"; feedback: string }
	| null;

/**
 * Show the implementation plan for user approval.
 *
 * Enter = approve. [E]xplore = deeper planning session.
 * Shift+Escape = redirect with feedback. Escape = cancel.
 */
export async function showPlanGate(
	ctx: ExtensionContext,
	planSummary: string,
): Promise<PlanGateResult> {
	const result = await promptSingle(ctx, {
		title: "Implementation Plan",
		content: (theme, width) => renderMarkdown(planSummary, theme, width),
		actions: [{ key: "e", label: "Explore" }],
		allowHScroll: true,
	});

	if (!result) return null;

	if (result.type === "redirect") {
		return { action: "redirect", feedback: result.note };
	}

	if (result.type === "action" && result.key === "e") {
		return { action: "explore", note: result.note };
	}

	// Enter (approve)
	return { action: "approve", note: result.note };
}
