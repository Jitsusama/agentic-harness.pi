/**
 * Confirmation gate for `action=post`.
 *
 * Posting hits GitHub and surfaces to every reviewer
 * watching the PR, so the gate pauses for an
 * in-terminal approval before firing. The user sees
 * the event type, finding counts, the rendered review
 * body and a per-finding listing.
 *
 * Rendering lives in `post-gate-render.ts` (pure,
 * tested); outcome reduction lives in
 * `post-gate-outcome.ts` (pure, tested); this module
 * owns the interactive shell via `promptSingle`.
 *
 * Headless behaviour: when the extension runs without
 * a UI (`ctx.hasUI === false`), the gate short-circuits
 * to approved with the body unchanged, matching the
 * reply/resolve gates.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promptSingle } from "../../lib/ui/panel.js";
import { withHiddenWorking } from "./gate-working.js";
import { type PostGateOutcome, postGateOutcome } from "./post-gate-outcome.js";
import {
	type PostGateSummary,
	renderPostGateContent,
} from "./post-gate-render.js";

const REJECT_ACTIONS = [{ key: "r", label: "Reject" }];

/**
 * Present the post gate and wait for the user's call.
 *
 * Enter approves with the rendered body unchanged.
 * `r` rejects. Escape cancels (treated as reject).
 * Shift+Escape opens the note editor; the entered
 * text replaces the review body.
 */
export async function confirmPostGate(
	ctx: ExtensionContext,
	summary: PostGateSummary,
): Promise<PostGateOutcome> {
	if (!ctx.hasUI) {
		return { approved: true, body: summary.body };
	}
	const result = await withHiddenWorking(ctx, () =>
		promptSingle(ctx, {
			title: `Post Review (${summary.event})`,
			content: renderPostGateContent(summary),
			actions: REJECT_ACTIONS,
			redirectHint: "Replace the review body…",
		}),
	);
	return postGateOutcome(result, summary.body);
}
