/**
 * Persistent status-line indicator for pr-workflow.
 *
 * Renders a one-line orientation hint about the loaded
 * PR, judge findings and pending fix queue. The line
 * stays visible across actions so the user always knows
 * what session they're in.
 *
 * The status-line for transient stage progress (council
 * fan-out) lives in `council-progress-render.ts` under a
 * different key. The two indicators coexist; pi
 * concatenates them in the status bar.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { summarizeFixQueue } from "./fix.js";
import type { PrWorkflowState } from "./state.js";

const STATUS_KEY = "pr-workflow:overview";

/**
 * Render the pr-workflow overview status line.
 *
 * Returns `undefined` when no PR is loaded so the line
 * disappears entirely instead of stuttering an empty
 * indicator.
 *
 * Format:
 *
 * ```
 *  PR42  9F  1Q
 * ```
 *
 * Segments after the PR ref appear only when they have a
 * non-zero count, so a freshly-loaded PR with no judge
 * run yet just shows ` PR42`.
 */
export function renderPrStatusLine(
	state: PrWorkflowState,
	theme: Theme,
): string | undefined {
	if (state.pr === null) return undefined;
	const segments: string[] = [];
	segments.push(theme.fg("accent", `\uE0A0 PR${state.pr.reference.number}`));

	const judge = state.council.lastJudge;
	if (judge !== null && judge.consolidatedFindings.length > 0) {
		segments.push(theme.fg("muted", `${judge.consolidatedFindings.length}F`));
	}

	const queue = summarizeFixQueue(state);
	if (queue.pending > 0) {
		segments.push(theme.fg("warning", `${queue.pending}Q`));
	}

	return segments.join("  ");
}

/**
 * Push the latest overview line into pi's status bar.
 * Idempotent: callers run this after every action that
 * might have moved state.
 */
export function refreshPrStatusLine(
	ctx: ExtensionContext,
	state: PrWorkflowState,
): void {
	ctx.ui.setStatus(STATUS_KEY, renderPrStatusLine(state, ctx.ui.theme));
}

/** Clear the indicator (e.g. when the extension shuts down). */
export function clearPrStatusLine(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}
