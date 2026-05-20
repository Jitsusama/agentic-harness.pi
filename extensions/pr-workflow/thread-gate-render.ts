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

import type { ContentRenderer } from "../../lib/ui/types.js";
import type { ReviewThread } from "./threads.js";

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
	return (theme, _width) => {
		const lines: string[] = [];
		lines.push(theme.fg("accent", ` Thread @ ${locationLabel(thread)}`));
		const flags = flagsLabel(thread);
		if (flags.length > 0) {
			lines.push(theme.fg("dim", `  ${flags}`));
		}
		lines.push("");
		lines.push(theme.fg("dim", " Existing comments:"));
		for (const c of thread.comments) {
			lines.push(` ${theme.fg("accent", `@${c.author}`)}: ${c.body}`);
		}
		lines.push("");
		lines.push(theme.fg("dim", " Proposed reply:"));
		for (const replyLine of body.split("\n")) {
			lines.push(` ${theme.fg("text", replyLine)}`);
		}
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
	return (theme, _width) => {
		const lines: string[] = [];
		lines.push(theme.fg("accent", ` Thread @ ${locationLabel(thread)}`));
		const flags = flagsLabel(thread);
		if (flags.length > 0) {
			lines.push(theme.fg("dim", `  ${flags}`));
		}
		lines.push("");
		lines.push(theme.fg("dim", " Existing comments:"));
		for (const c of thread.comments) {
			lines.push(` ${theme.fg("accent", `@${c.author}`)}: ${c.body}`);
		}
		lines.push("");
		lines.push(theme.fg("warning", " Mark thread resolved."));
		return lines;
	};
}
