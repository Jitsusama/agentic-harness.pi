/**
 * Pure renderers for the thread reply / resolve confirmation
 * gates. Kept separate from `thread-gate.ts` so tests can
 * exercise the layout without dragging in the panel runtime
 * (which depends on pi's TUI module at load time).
 *
 * Each renderer returns a `ContentRenderer`: a function that
 * takes a theme + width and emits themed lines for the panel
 * content area.
 */

import { contentWrapWidth, wordWrap } from "../../lib/ui/text-layout.js";
import type { ContentRenderer } from "../../lib/ui/types.js";
import type { ReviewThread, ReviewThreadComment } from "./threads.js";

/**
 * Format a thread's location as `path:line`, `path`,
 * `(review-level)` or `(PR-level)` depending on shape.
 */
function locationLabel(thread: ReviewThread): string {
	if (thread.kind === "review-level") return "(review-level)";
	if (thread.path === null) return "(PR-level)";
	if (thread.line === null) return thread.path;
	return `${thread.path}:${thread.line}`;
}

/** Format thread flags (`resolved`, `outdated`) as a `(…)` suffix or empty. */
function flagsLabel(thread: ReviewThread): string {
	const flags: string[] = [];
	if (thread.isResolved) flags.push("resolved");
	if (thread.isOutdated) flags.push("outdated");
	if (flags.length === 0) return "";
	return `(${flags.join(", ")})`;
}

/**
 * Pure renderer for the reply gate's content area.
 *
 * Shows the thread header (location + flags), every existing
 * comment in order, and the proposed reply at the bottom.
 */
export function renderReplyGateContent(
	thread: ReviewThread,
	body: string,
): ContentRenderer {
	return (theme, width) => {
		const lines: string[] = [];
		const wrapWidth = contentWrapWidth(width);
		lines.push(theme.fg("accent", ` Thread @ ${locationLabel(thread)}`));
		const flags = flagsLabel(thread);
		if (flags.length > 0) {
			lines.push(theme.fg("dim", `  ${flags}`));
		}
		lines.push("");
		lines.push(theme.fg("dim", " Existing comments:"));
		pushComments(lines, thread.comments, wrapWidth);
		lines.push("");
		lines.push(theme.fg("dim", " Proposed reply:"));
		pushWrapped(lines, body, wrapWidth - 1);
		return lines;
	};
}

/**
 * Pure renderer for the combined reply-and-resolve gate.
 *
 * One gate, both effects: shows the thread, the proposed
 * reply, and an explicit line stating the thread will be
 * resolved once the reply posts. Replaces the two-gate dance
 * (reply, then resolve) with a single approval.
 */
export function renderReplyAndResolveGateContent(
	thread: ReviewThread,
	body: string,
): ContentRenderer {
	return (theme, width) => {
		const lines: string[] = [];
		const wrapWidth = contentWrapWidth(width);
		lines.push(theme.fg("accent", ` Thread @ ${locationLabel(thread)}`));
		const flags = flagsLabel(thread);
		if (flags.length > 0) {
			lines.push(theme.fg("dim", `  ${flags}`));
		}
		lines.push("");
		lines.push(theme.fg("dim", " Existing comments:"));
		pushComments(lines, thread.comments, wrapWidth);
		lines.push("");
		lines.push(theme.fg("dim", " Proposed reply:"));
		pushWrapped(lines, body, wrapWidth - 1);
		lines.push("");
		lines.push(theme.fg("warning", " Then mark the thread resolved."));
		return lines;
	};
}

/**
 * Pure renderer for the resolve gate's content area.
 *
 * Shows the thread header, existing comments, and an
 * explicit `Mark thread resolved.` intent line.
 */
export function renderResolveGateContent(
	thread: ReviewThread,
): ContentRenderer {
	return (theme, width) => {
		const lines: string[] = [];
		const wrapWidth = contentWrapWidth(width);
		lines.push(theme.fg("accent", ` Thread @ ${locationLabel(thread)}`));
		const flags = flagsLabel(thread);
		if (flags.length > 0) {
			lines.push(theme.fg("dim", `  ${flags}`));
		}
		lines.push("");
		lines.push(theme.fg("dim", " Existing comments:"));
		pushComments(lines, thread.comments, wrapWidth);
		lines.push("");
		lines.push(theme.fg("warning", " Mark thread resolved."));
		return lines;
	};
}

function pushComments(
	lines: string[],
	comments: readonly ReviewThreadComment[],
	wrapWidth: number,
): void {
	for (const comment of comments) {
		pushWrapped(lines, `@${comment.author}: ${comment.body}`, wrapWidth - 1);
	}
}

function pushWrapped(lines: string[], text: string, wrapWidth: number): void {
	for (const wrappedLine of wordWrap(text, wrapWidth)) {
		lines.push(` ${wrappedLine}`);
	}
}
