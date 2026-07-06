/**
 * Confirmation gates for thread reply / resolve actions.
 *
 * Both reply and resolve hit GitHub remotely and surface to
 * other reviewers, so they pause for an in-terminal approval
 * before firing. The gates render the thread's existing
 * comments alongside the proposed reply (or the resolution
 * intent) so the user can sanity-check what's about to ship.
 *
 * Rendering lives in `thread-gate-render.ts` (pure, tested);
 * this module owns the interactive shell via `promptSingle`.
 *
 * Headless behaviour: when the extension runs without a UI
 * (`ctx.hasUI === false`), both gates short-circuit to
 * approved with the proposed body unchanged. The user is
 * trusted to have approved out-of-band when there's no
 * panel to render.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promptSingle } from "../../lib/ui/panel.js";
import type { ContentRenderer } from "../../lib/ui/types.js";
import { withHiddenWorking } from "./gate-working.js";
import {
	type ReplyGateOutcome,
	type ResolveGateOutcome,
	replyGateOutcome,
	resolveGateOutcome,
} from "./thread-gate-outcome.js";
import {
	renderReplyAndResolveGateContent,
	renderReplyGateContent,
	renderResolveGateContent,
} from "./thread-gate-render.js";
import type { ReviewThread } from "./threads.js";

const REJECT_ACTIONS = [{ key: "r", label: "Reject" }];

/**
 * Present the reply gate and wait for the user's call.
 *
 * Enter approves with the proposed body unchanged. `r`
 * rejects. Escape cancels (same outcome as reject). Shift +
 * Escape opens the note editor; the entered note replaces
 * the proposed body, letting the user edit inline instead of
 * round-tripping through the agent.
 */
export async function confirmReplyGate(
	ctx: ExtensionContext,
	thread: ReviewThread,
	body: string,
): Promise<ReplyGateOutcome> {
	if (!ctx.hasUI) {
		return { approved: true, body };
	}
	const result = await withHiddenWorking(ctx, () =>
		promptSingle(ctx, {
			title: "Reply to Thread",
			content: renderReplyGateContent(thread, body),
			actions: REJECT_ACTIONS,
			redirectHint: "Replace the reply text…",
		}),
	);
	return replyGateOutcome(result, body);
}

/**
 * Present the combined reply-and-resolve gate and wait for the
 * user's call. One approval covers both the reply and the
 * resolution, so the user no longer pays two gates to do what
 * is conceptually one action.
 *
 * Enter approves with the proposed body unchanged and both
 * effects fire. `r` rejects (nothing fires). Escape cancels.
 * Shift + Escape opens the note editor; the entered note
 * replaces the reply body, same as the reply-only gate. The
 * resolution is implied by the gate's identity — there is no
 * separate yes/no on it.
 */
export async function confirmReplyAndResolveGate(
	ctx: ExtensionContext,
	thread: ReviewThread,
	body: string,
): Promise<ReplyGateOutcome> {
	if (!ctx.hasUI) {
		return { approved: true, body };
	}
	const result = await withHiddenWorking(ctx, () =>
		promptSingle(ctx, {
			title: "Reply & Resolve Thread",
			content: renderReplyAndResolveGateContent(thread, body),
			actions: REJECT_ACTIONS,
			redirectHint: "Replace the reply text…",
		}),
	);
	return replyGateOutcome(result, body);
}

/**
 * Present the resolve gate and wait for the user's call.
 *
 * Enter approves. `r` rejects. Escape cancels (same outcome
 * as reject). Resolve has no redirect path: there's nothing
 * to edit, just a yes / no on closing the thread.
 */
export async function confirmResolveGate(
	ctx: ExtensionContext,
	thread: ReviewThread,
): Promise<ResolveGateOutcome> {
	if (!ctx.hasUI) {
		return { approved: true };
	}
	const result = await withHiddenWorking(ctx, () =>
		promptSingle(ctx, {
			title: "Resolve Thread",
			content: renderResolveGateContent(thread),
			actions: REJECT_ACTIONS,
		}),
	);
	return resolveGateOutcome(result);
}

/**
 * Present one gate covering several threads to resolve, so a
 * batch resolve confirms once rather than per thread. Enter
 * approves the whole set; `r` or escape rejects it.
 */
export async function confirmResolveManyGate(
	ctx: ExtensionContext,
	threads: readonly ReviewThread[],
): Promise<ResolveGateOutcome> {
	if (!ctx.hasUI) {
		return { approved: true };
	}
	const content: ContentRenderer = (theme, width) => {
		const lines: string[] = [];
		lines.push(
			theme.fg("warning", ` Mark ${threads.length} threads resolved.`),
		);
		for (const thread of threads) {
			lines.push("");
			lines.push(...renderResolveGateContent(thread)(theme, width));
		}
		return lines;
	};
	const result = await withHiddenWorking(ctx, () =>
		promptSingle(ctx, {
			title: "Resolve Threads",
			content,
			actions: REJECT_ACTIONS,
		}),
	);
	return resolveGateOutcome(result);
}
