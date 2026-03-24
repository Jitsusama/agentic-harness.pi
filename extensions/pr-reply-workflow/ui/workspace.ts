/**
 * PR Reply workspace: navigation surface for reviewer tabs.
 *
 * The workspace is for BROWSING threads: seeing the big picture,
 * checking status, picking what to work on next. When the user
 * selects a thread (Enter), the workspace dismisses and returns
 * the thread ID so the handler can open a full-context gate.
 *
 * Pass is inline (no context needed). Implement and reply go
 * through the gate for full code context + LLM analysis.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { renderMarkdown } from "../../lib/ui/content-renderer.js";
import { workspace } from "../../lib/ui/panel.js";
import { tabCompletion } from "../../lib/ui/tab-completion.js";
import {
	CONTENT_INDENT,
	contentWrapWidth,
	wordWrap,
} from "../../lib/ui/text-layout.js";
import type {
	WorkspaceInputContext,
	WorkspaceItem,
	WorkspaceResult,
	WorkspaceView,
} from "../../lib/ui/types.js";
import type {
	PRReplyState,
	ReceivedReview,
	ReviewThread,
	ThreadAnalysis,
	ThreadState,
} from "../state.js";
import { threadsForReview } from "../state.js";

/** Status glyphs for threads. */
const THREAD_GLYPH: Record<ThreadState, string> = {
	pending: "●",
	implementing: "◈",
	addressed: "◆",
	replied: "◆",
	passed: "◆",
};

/** Glyph colors by thread state. */
const THREAD_GLYPH_COLOR: Record<ThreadState, string> = {
	pending: "accent",
	implementing: "accent",
	addressed: "success",
	replied: "success",
	passed: "success",
};

/** Standard content indentation for workspace lines. */
const pad = " ".repeat(CONTENT_INDENT);

/** Result from the workspace: which action the user chose. */
export type WorkspaceAction =
	| { action: "open"; threadId: string }
	| { action: "pass"; threadId: string }
	| { action: "redirect"; threadId: string | null; note: string }
	| null;

/**
 * Show the PR reply workspace. Returns the user's chosen action,
 * or null on cancel (Escape).
 */
export async function showReplyWorkspace(
	ctx: ExtensionContext,
	state: PRReplyState,
): Promise<WorkspaceAction> {
	const { reviews, threads, threadStates, threadAnalyses } = state;

	// This is mutable selection state, tracked per reviewer tab.
	const threadIndices = new Map<string, number>();

	// We restore the position from state.
	const savedPos = state.workspacePosition;
	if (savedPos?.threadIndices) {
		for (const [key, val] of savedPos.threadIndices) {
			threadIndices.set(key, val);
		}
	}

	// We track which reviewer tabs are complete.
	const tabComplete = new Set<string>();
	for (const review of reviews) {
		const reviewThreads = threadsForReview(review, threads);
		const allDone = reviewThreads.every((t) => {
			const st = threadStates.get(t.id);
			return st && st !== "pending";
		});
		if (allDone) tabComplete.add(review.id);
	}

	// We track the thread the user is acting on.
	let actionThreadId: string | null = null;

	// We build the workspace items.
	const items: WorkspaceItem[] = [
		buildSummaryTab(state),
		...reviews.map((review) =>
			buildReviewerTab(
				review,
				threads,
				threadStates,
				threadAnalyses,
				threadIndices,
				tabComplete,
				(id) => {
					actionThreadId = id;
				},
			),
		),
	];

	const tabIds = ["summary", ...reviews.map((r) => r.id)];

	const reviewIds = reviews.map((r) => r.id);
	const completion = tabCompletion(
		tabIds,
		(id) => tabComplete.has(id),
		reviewIds,
	);

	const result: WorkspaceResult = await workspace(ctx, {
		items,
		...completion,
		allowHScroll: true,
	});

	// We save the workspace position.
	state.workspacePosition = {
		tabIndex: 0,
		threadIndices: new Map(threadIndices),
	};

	if (!result) return null;

	if (result.type === "redirect") {
		return { action: "redirect", threadId: actionThreadId, note: result.note };
	}

	if (result.type === "action" && result.key === "p" && actionThreadId) {
		return { action: "pass", threadId: actionThreadId };
	}

	if (result.type === "submit" && actionThreadId) {
		return { action: "open", threadId: actionThreadId };
	}

	return null;
}

/** Build the Summary tab showing PR overview and progress. */
function buildSummaryTab(state: PRReplyState): WorkspaceItem {
	const summaryView: WorkspaceView = {
		key: "1",
		label: "Overview",
		content: (theme: Theme) => {
			const lines: string[] = [];

			lines.push(` ${theme.fg("accent", theme.bold(`PR #${state.prNumber}`))}`);
			if (state.owner && state.repo) {
				lines.push(`${pad}${theme.fg("dim", `${state.owner}/${state.repo}`)}`);
			}
			if (state.branch) {
				lines.push(`${pad}${theme.fg("dim", `Branch: ${state.branch}`)}`);
			}
			lines.push("");

			// Progress
			let replied = 0;
			let addressed = 0;
			let implementing = 0;
			let pending = 0;
			let passed = 0;
			for (const [, st] of state.threadStates) {
				if (st === "replied") replied++;
				else if (st === "addressed") addressed++;
				else if (st === "implementing") implementing++;
				else if (st === "pending") pending++;
				else if (st === "passed") passed++;
			}
			const total = state.threads.length;
			const done = replied + addressed + passed;

			lines.push(` ${theme.fg("text", theme.bold("Progress:"))}`);
			lines.push(
				`${pad}${theme.fg("success", `${done}/${total} threads done`)}`,
			);
			if (pending > 0) {
				lines.push(`${pad}${theme.fg("accent", `${pending} pending`)}`);
			}
			if (implementing > 0) {
				lines.push(
					`${pad}${theme.fg("accent", `${implementing} implementing`)}`,
				);
			}
			lines.push("");

			// Reviewer summary
			lines.push(` ${theme.fg("text", theme.bold("Reviews:"))}`);
			for (const review of state.reviews) {
				const reviewThreads = threadsForReview(review, state.threads);
				const reviewPending = reviewThreads.filter(
					(t) => state.threadStates.get(t.id) === "pending",
				).length;
				const stateColor =
					review.state === "CHANGES_REQUESTED"
						? "error"
						: review.state === "APPROVED"
							? "success"
							: "accent";
				lines.push(
					`${pad}${theme.fg(stateColor, review.state)} ${review.author}: ${reviewThreads.length} thread${reviewThreads.length !== 1 ? "s" : ""} (${reviewPending} pending)`,
				);
			}

			return lines;
		},
	};

	return { label: "Summary", views: [summaryView] };
}

/**
 * Build a reviewer tab: single view with reviewer header,
 * review body, and navigable thread list. Enter on a thread
 * opens the full-context gate.
 */
function buildReviewerTab(
	review: ReceivedReview,
	allThreads: ReviewThread[],
	threadStates: Map<string, ThreadState>,
	threadAnalyses: Map<string, ThreadAnalysis>,
	threadIndices: Map<string, number>,
	tabComplete: Set<string>,
	setActionThread: (id: string) => void,
): WorkspaceItem {
	const reviewThreads = threadsForReview(review, allThreads);

	const getIndex = () => threadIndices.get(review.id) ?? 0;
	const setIndex = (i: number) => threadIndices.set(review.id, i);

	const view: WorkspaceView = {
		key: "1",
		label: "Threads",
		actions: [{ key: "p", label: "Pass" }],
		enterHint: "select",
		content: (theme: Theme, width: number) => {
			const lines: string[] = [];

			// Reviewer header
			const stateColor =
				review.state === "CHANGES_REQUESTED"
					? "error"
					: review.state === "APPROVED"
						? "success"
						: "accent";
			lines.push(
				` ${theme.fg("accent", theme.bold(review.author))} ${theme.fg(stateColor, review.state)}`,
			);
			lines.push("");

			// Review body (if any)
			if (review.body) {
				lines.push(...renderMarkdown(review.body, theme, width));
				lines.push("");
			}

			// Navigable thread list
			lines.push(
				...renderThreadList(
					reviewThreads,
					threadStates,
					threadAnalyses,
					getIndex(),
					theme,
					width,
				),
			);

			return lines;
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			if (reviewThreads.length === 0) return false;

			// ↑↓ navigation
			if (matchesKey(data, Key.up)) {
				setIndex(
					(getIndex() - 1 + reviewThreads.length) % reviewThreads.length,
				);
				inputCtx.invalidate();
				updateActionThread(reviewThreads, getIndex, setActionThread);
				return true;
			}
			if (matchesKey(data, Key.down)) {
				setIndex((getIndex() + 1) % reviewThreads.length);
				inputCtx.invalidate();
				updateActionThread(reviewThreads, getIndex, setActionThread);
				return true;
			}

			const thread = reviewThreads[getIndex()];
			if (!thread) return false;

			setActionThread(thread.id);

			// Enter: open the full-context gate
			if (matchesKey(data, Key.enter)) {
				inputCtx.done({ type: "submit" });
				return true;
			}

			// Pass inline
			if (matchesKey(data, "p")) {
				const st = threadStates.get(thread.id);
				if (st === "pending") {
					threadStates.set(thread.id, "passed");
					checkTabAutoComplete(
						review.id,
						reviewThreads,
						threadStates,
						tabComplete,
					);
					advanceToNextPending(reviewThreads, threadStates, getIndex, setIndex);
					inputCtx.invalidate();
				}
				return true;
			}

			return false;
		},
	};

	return { label: review.author, views: [view] };
}

/**
 * Render a compact thread list for navigation.
 * Shows file:line, status, and recommendation: no expanded views.
 * The full context is shown in the gate when the user enters a thread.
 */
function renderThreadList(
	threads: ReviewThread[],
	threadStates: Map<string, ThreadState>,
	threadAnalyses: Map<string, ThreadAnalysis>,
	selectedIndex: number,
	theme: Theme,
	width: number,
): string[] {
	const wrapWidth = contentWrapWidth(width);
	const lines: string[] = [];

	if (threads.length === 0) {
		lines.push(`${pad}${theme.fg("dim", "No threads.")}`);
		return lines;
	}

	for (let i = 0; i < threads.length; i++) {
		const thread = threads[i];
		if (!thread) continue;
		const isSel = i === selectedIndex;
		const st = threadStates.get(thread.id) ?? "pending";
		const cursor = isSel ? "▸ " : "  ";
		const glyph = THREAD_GLYPH[st];
		const glyphColor = THREAD_GLYPH_COLOR[st];

		const analysis = threadAnalyses.get(thread.id);
		const rec = analysis ? ` → ${analysis.recommendation}` : "";

		const location = `${thread.file}:${thread.line}`;
		const summary = `${location}${rec}`;
		const line = `${pad}${cursor}${theme.fg(glyphColor, glyph)} ${summary} ${theme.fg("dim", `[${st}]`)}`;
		lines.push(isSel ? theme.fg("accent", line) : line);

		// We show the snippet on the second line.
		const snippet =
			thread.comments[0]?.body.slice(0, 70).replace(/\n/g, " ") ?? "";
		const ellipsis = (thread.comments[0]?.body.length ?? 0) > 70 ? "…" : "";
		if (snippet) {
			for (const wl of wordWrap(`${snippet}${ellipsis}`, wrapWidth - 8)) {
				lines.push(
					`${pad}      ${isSel ? theme.fg("accent", theme.fg("dim", wl)) : theme.fg("dim", wl)}`,
				);
			}
		}
	}

	return lines;
}

/** Update the action thread to the currently selected thread. */
function updateActionThread(
	threads: ReviewThread[],
	getIndex: () => number,
	setActionThread: (id: string) => void,
): void {
	const thread = threads[getIndex()];
	if (thread) setActionThread(thread.id);
}

/** Advance selection to the next pending thread. */
function advanceToNextPending(
	threads: ReviewThread[],
	threadStates: Map<string, ThreadState>,
	getIndex: () => number,
	setIndex: (i: number) => void,
): void {
	const current = getIndex();
	for (let i = 1; i <= threads.length; i++) {
		const next = (current + i) % threads.length;
		const st = threadStates.get(threads[next]?.id ?? "");
		if (st === "pending") {
			setIndex(next);
			return;
		}
	}
}

/** Auto-mark reviewer tab as handled when all threads are resolved. */
function checkTabAutoComplete(
	reviewId: string,
	threads: ReviewThread[],
	threadStates: Map<string, ThreadState>,
	tabComplete: Set<string>,
): void {
	const allResolved = threads.every((t) => {
		const st = threadStates.get(t.id);
		return st && st !== "pending";
	});
	if (allResolved) {
		tabComplete.add(reviewId);
	}
}
