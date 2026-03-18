/**
 * PR Reply workspace — navigation surface for reviewer tabs.
 *
 * The workspace is for BROWSING threads — seeing the big picture,
 * checking status, picking what to work on next. When the user
 * selects a thread (Enter), the workspace dismisses and returns
 * the thread ID so the handler can open a full-context gate.
 *
 * Skip and defer are inline (no context needed). Implement and
 * reply go through the gate for full code context + LLM analysis.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { renderMarkdown } from "../../lib/ui/content-renderer.js";
import { workspace } from "../../lib/ui/panel.js";
import { contentWrapWidth, wordWrap } from "../../lib/ui/text.js";
import type {
	WorkspaceInputContext,
	WorkspaceItem,
	WorkspaceResult,
	WorkspaceView,
} from "../../lib/ui/types.js";
import type {
	PRReplyState,
	Review,
	Thread,
	ThreadAnalysis,
	ThreadState,
} from "../state.js";
import { threadsForReview } from "../state.js";

// ---- Constants ----

/** Status glyphs for threads. */
const THREAD_GLYPH: Record<ThreadState, string> = {
	pending: "●",
	implementing: "◈",
	addressed: "◆",
	replied: "◆",
	deferred: "◇",
	skipped: "✕",
};

/** Glyph colors by thread state. */
const THREAD_GLYPH_COLOR: Record<ThreadState, string> = {
	pending: "accent",
	implementing: "accent",
	addressed: "success",
	replied: "success",
	deferred: "dim",
	skipped: "error",
};

// ---- Result types ----

/** Result from the workspace — which action the user chose. */
export type WorkspaceAction =
	| { action: "open"; threadId: string }
	| { action: "skip"; threadId: string }
	| { action: "defer"; threadId: string }
	| { action: "steer"; threadId: string | null; note: string }
	| null;

// ---- Public API ----

/**
 * Show the PR reply workspace. Returns the user's chosen action,
 * or null on cancel (Escape).
 */
export async function showReplyWorkspace(
	ctx: ExtensionContext,
	state: PRReplyState,
): Promise<WorkspaceAction> {
	const { reviews, threads, threadStates, threadAnalyses } = state;

	// Mutable selection state per reviewer tab
	const threadIndices = new Map<string, number>();

	// Restore position from state
	const savedPos = state.workspacePosition;
	if (savedPos?.threadIndices) {
		for (const [key, val] of savedPos.threadIndices) {
			threadIndices.set(key, val);
		}
	}

	// Track which reviewer tabs are complete
	const tabHandled = new Set<string>();
	for (const review of reviews) {
		const reviewThreads = threadsForReview(review, threads);
		const allDone = reviewThreads.every((t) => {
			const st = threadStates.get(t.id);
			return st && st !== "pending";
		});
		if (allDone) tabHandled.add(review.id);
	}

	// Track the thread the user is acting on
	let actionThreadId: string | null = null;

	// Build workspace items
	const items: WorkspaceItem[] = [
		buildSummaryTab(state),
		...reviews.map((review) =>
			buildReviewerTab(
				review,
				threads,
				threadStates,
				threadAnalyses,
				threadIndices,
				tabHandled,
				(id) => {
					actionThreadId = id;
				},
			),
		),
	];

	const tabIds = ["summary", ...reviews.map((r) => r.id)];

	const result: WorkspaceResult = await workspace(ctx, {
		items,
		tabStatus: (index) => {
			const tabId = tabIds[index];
			if (!tabId || tabId === "summary") return "pending";
			return tabHandled.has(tabId) ? "complete" : "pending";
		},
		allComplete: () => reviews.every((r) => tabHandled.has(r.id)),
		allowHScroll: true,
	});

	// Save workspace position
	state.workspacePosition = {
		tabIndex: 0,
		threadIndices: new Map(threadIndices),
	};

	if (!result) return null;

	if (result.type === "steer") {
		return { action: "steer", threadId: actionThreadId, note: result.note };
	}

	if (result.type === "action" && result.value === "e" && actionThreadId) {
		return { action: "open", threadId: actionThreadId };
	}

	return null;
}

// ---- Summary tab ----

/** Build the Summary tab showing PR overview and progress. */
function buildSummaryTab(state: PRReplyState): WorkspaceItem {
	const summaryView: WorkspaceView = {
		key: "o",
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
			let deferred = 0;
			let skipped = 0;
			for (const [, st] of state.threadStates) {
				if (st === "replied") replied++;
				else if (st === "addressed") addressed++;
				else if (st === "implementing") implementing++;
				else if (st === "pending") pending++;
				else if (st === "deferred") deferred++;
				else if (st === "skipped") skipped++;
			}
			const total = state.threads.length;
			const done = replied + addressed + skipped;

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
			if (deferred > 0) {
				lines.push(`${pad}${theme.fg("dim", `${deferred} deferred`)}`);
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
					`${pad}${theme.fg(stateColor, review.state)} ${review.author} — ${reviewThreads.length} thread${reviewThreads.length !== 1 ? "s" : ""} (${reviewPending} pending)`,
				);
			}

			return lines;
		},
	};

	return { label: "Summary", views: [summaryView] };
}

// ---- Reviewer tabs ----

/**
 * Build a reviewer tab — single view with reviewer header,
 * review body, and navigable thread list. Enter on a thread
 * opens the full-context gate.
 */
function buildReviewerTab(
	review: Review,
	allThreads: Thread[],
	threadStates: Map<string, ThreadState>,
	threadAnalyses: Map<string, ThreadAnalysis>,
	threadIndices: Map<string, number>,
	tabHandled: Set<string>,
	setActionThread: (id: string) => void,
): WorkspaceItem {
	const reviewThreads = threadsForReview(review, allThreads);

	const getIndex = () => threadIndices.get(review.id) ?? 0;
	const setIndex = (i: number) => threadIndices.set(review.id, i);

	const view: WorkspaceView = {
		key: "t",
		label: "Threads",
		actions: [
			{ key: "e", label: "Enter" },
			{ key: "d", label: "Defer" },
			{ key: "k", label: "sKip" },
		],
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

			// Enter — open the full-context gate
			if (matchesKey(data, Key.enter) || matchesKey(data, "e")) {
				inputCtx.done({ type: "action", value: "e" });
				return true;
			}

			// Defer inline
			if (matchesKey(data, "d")) {
				const st = threadStates.get(thread.id);
				if (st === "pending") {
					threadStates.set(thread.id, "deferred");
					checkTabAutoHandled(
						review.id,
						reviewThreads,
						threadStates,
						tabHandled,
					);
					advanceToNextPending(reviewThreads, threadStates, getIndex, setIndex);
					inputCtx.invalidate();
				}
				return true;
			}

			// Skip inline
			if (matchesKey(data, "k")) {
				const st = threadStates.get(thread.id);
				if (st === "pending") {
					threadStates.set(thread.id, "skipped");
					checkTabAutoHandled(
						review.id,
						reviewThreads,
						threadStates,
						tabHandled,
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

// ---- Thread list rendering ----

/**
 * Render a compact thread list for navigation.
 * Shows file:line, status, and recommendation — no expanded views.
 * The full context is shown in the gate when the user enters a thread.
 */
function renderThreadList(
	threads: Thread[],
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

		// Show snippet on second line
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

// ---- Helpers ----

/** Update the action thread to the currently selected thread. */
function updateActionThread(
	threads: Thread[],
	getIndex: () => number,
	setActionThread: (id: string) => void,
): void {
	const thread = threads[getIndex()];
	if (thread) setActionThread(thread.id);
}

/** Advance selection to the next pending thread. */
function advanceToNextPending(
	threads: Thread[],
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
function checkTabAutoHandled(
	reviewId: string,
	threads: Thread[],
	threadStates: Map<string, ThreadState>,
	tabHandled: Set<string>,
): void {
	const allResolved = threads.every((t) => {
		const st = threadStates.get(t.id);
		return st && st !== "pending";
	});
	if (allResolved) {
		tabHandled.add(reviewId);
	}
}
