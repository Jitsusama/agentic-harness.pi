/**
 * PR Reply workspace — reviewer-tab workspace with three views
 * per tab: Overview, Threads, Source.
 *
 * Mirrors pr-review's review panel structure. Each reviewer is
 * a tab. Threads within a review are a selectable list. Actions
 * (implement/reply/defer/skip) apply to the selected thread.
 */

import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import {
	languageFromPath,
	renderCode,
	renderMarkdown,
} from "../../lib/ui/content-renderer.js";
import { workspace } from "../../lib/ui/panel.js";
import {
	CONTENT_INDENT,
	contentWrapWidth,
	wordWrap,
} from "../../lib/ui/text.js";
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
	| { action: "implement"; threadId: string }
	| { action: "reply"; threadId: string }
	| { action: "defer"; threadId: string }
	| { action: "skip"; threadId: string }
	| { action: "steer"; threadId: string | null; note: string }
	| null;

// ---- Public API ----

/**
 * Show the PR reply workspace. Returns the user's chosen action,
 * or null on cancel (Escape).
 *
 * Restores workspace position from state if available.
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
		globalActions: [
			{ key: "i", label: "Implement" },
			{ key: "r", label: "Reply" },
			{ key: "d", label: "Defer" },
			{ key: "k", label: "sKip" },
		],
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
		tabIndex: 0, // Will be updated by the workspace if we had access
		threadIndices: new Map(threadIndices),
	};

	if (!result) return null;

	if (result.type === "steer") {
		return { action: "steer", threadId: actionThreadId, note: result.note };
	}

	if (result.type === "action" && actionThreadId) {
		const actionMap: Record<string, WorkspaceAction["action" & string]> = {
			i: "implement",
			r: "reply",
			d: "defer",
			k: "skip",
		};
		const action = actionMap[result.value];
		if (action) {
			return { action, threadId: actionThreadId };
		}
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
			const pad = " ".repeat(CONTENT_INDENT);
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
			const total = state.threads.length;
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

/** Build a reviewer tab with Overview/Threads/Source views. */
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

	return {
		label: review.author,
		views: [
			buildReviewOverview(review, reviewThreads, threadStates, threadAnalyses),
			buildThreadsView(
				review,
				reviewThreads,
				threadStates,
				threadAnalyses,
				getIndex,
				setIndex,
				tabHandled,
				setActionThread,
			),
			buildSourceView(reviewThreads, getIndex),
		],
		allowHScroll: true,
	};
}

/** Overview view — reviewer comment, state, thread summary list. */
function buildReviewOverview(
	review: Review,
	reviewThreads: Thread[],
	threadStates: Map<string, ThreadState>,
	threadAnalyses: Map<string, ThreadAnalysis>,
): WorkspaceView {
	return {
		key: "o",
		label: "Overview",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
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
			lines.push(
				`${pad}${theme.fg("dim", `${reviewThreads.length} thread${reviewThreads.length !== 1 ? "s" : ""}`)}`,
			);
			lines.push("");

			// Review body
			if (review.body) {
				lines.push(...renderMarkdown(review.body, theme, width));
				lines.push("");
			}

			// Thread summary list
			lines.push(` ${theme.fg("text", theme.bold("Threads:"))}`);
			for (const thread of reviewThreads) {
				const st = threadStates.get(thread.id) ?? "pending";
				const glyph = THREAD_GLYPH[st];
				const color = THREAD_GLYPH_COLOR[st];
				const analysis = threadAnalyses.get(thread.id);
				const rec = analysis?.recommendation ?? "";

				const snippet =
					thread.comments[0]?.body.slice(0, 50).replace(/\n/g, " ") ?? "";
				const ellipsis = (thread.comments[0]?.body.length ?? 0) > 50 ? "…" : "";

				lines.push(
					`${pad}${theme.fg(color, glyph)} ${thread.file}:${thread.line} ${theme.fg("dim", rec)}`,
				);
				lines.push(`${pad}    ${theme.fg("dim", `${snippet}${ellipsis}`)}`);
			}

			return lines;
		},
	};
}

/** Threads view — selectable list with conversation + recommendation. */
function buildThreadsView(
	review: Review,
	reviewThreads: Thread[],
	threadStates: Map<string, ThreadState>,
	threadAnalyses: Map<string, ThreadAnalysis>,
	getIndex: () => number,
	setIndex: (i: number) => void,
	tabHandled: Set<string>,
	setActionThread: (id: string) => void,
): WorkspaceView {
	return {
		key: "t",
		label: "Threads",
		actions: [
			{ key: "i", label: "Implement" },
			{ key: "r", label: "Reply" },
			{ key: "d", label: "Defer" },
			{ key: "k", label: "sKip" },
		],
		content: (theme: Theme, width: number) => {
			return renderThreadList(
				reviewThreads,
				threadStates,
				threadAnalyses,
				getIndex(),
				theme,
				width,
			);
		},
		handleInput: (data: string, inputCtx: WorkspaceInputContext) => {
			if (reviewThreads.length === 0) return false;

			// ↑↓ navigation
			if (matchesKey(data, Key.up)) {
				setIndex(
					(getIndex() - 1 + reviewThreads.length) % reviewThreads.length,
				);
				inputCtx.invalidate();
				inputCtx.scrollToLine(getIndex());
				updateActionThread(reviewThreads, getIndex, setActionThread);
				return true;
			}
			if (matchesKey(data, Key.down)) {
				setIndex((getIndex() + 1) % reviewThreads.length);
				inputCtx.invalidate();
				inputCtx.scrollToLine(getIndex());
				updateActionThread(reviewThreads, getIndex, setActionThread);
				return true;
			}

			const thread = reviewThreads[getIndex()];
			if (!thread) return false;

			// Set action thread for any action key
			setActionThread(thread.id);

			// Actions — these close the workspace via done()
			if (matchesKey(data, "i")) {
				inputCtx.done({ type: "action", value: "i" });
				return true;
			}
			if (matchesKey(data, "r")) {
				inputCtx.done({ type: "action", value: "r" });
				return true;
			}
			if (matchesKey(data, "d")) {
				// Defer inline — mark and advance
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
					inputCtx.scrollToLine(getIndex());
				}
				return true;
			}
			if (matchesKey(data, "k")) {
				// Skip inline — mark and advance
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
					inputCtx.scrollToLine(getIndex());
				}
				return true;
			}

			// Steer on current thread
			if (matchesKey(data, "s")) {
				setActionThread(thread.id);
				inputCtx.openEditor(`Feedback on ${thread.file}:${thread.line}:`);
				return true;
			}

			return false;
		},
	};
}

/** Source view — code context around the selected thread's location. */
function buildSourceView(
	reviewThreads: Thread[],
	getIndex: () => number,
): WorkspaceView {
	return {
		key: "s",
		label: "Source",
		content: (theme: Theme, width: number) => {
			const pad = " ".repeat(CONTENT_INDENT);
			const thread = reviewThreads[getIndex()];
			if (!thread) {
				return [`${pad}${theme.fg("dim", "No thread selected.")}`];
			}

			const filePath = thread.file;
			const contextLine = thread.line || thread.originalLine || 0;

			let source: string;
			try {
				source = fs.readFileSync(filePath, "utf-8");
			} catch {
				return [`${pad}${theme.fg("dim", `(${filePath} not available)`)}`];
			}

			return renderCode(source, theme, width, {
				startLine: 1,
				highlightLines: contextLine > 0 ? new Set([contextLine]) : undefined,
				language: languageFromPath(filePath),
			});
		},
	};
}

// ---- Thread list rendering ----

/** Render a selectable thread list with expanded conversation. */
function renderThreadList(
	threads: Thread[],
	threadStates: Map<string, ThreadState>,
	threadAnalyses: Map<string, ThreadAnalysis>,
	selectedIndex: number,
	theme: Theme,
	width: number,
): string[] {
	const pad = " ".repeat(CONTENT_INDENT);
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

		const location = `${thread.file}:${thread.line}`;
		const line = `${pad}${cursor}${theme.fg(glyphColor, glyph)} ${location} ${theme.fg("dim", `[${st}]`)}`;
		lines.push(isSel ? theme.fg("accent", line) : line);

		// Expanded view for selected thread
		if (isSel) {
			lines.push("");

			// Original comment
			const original = thread.comments.find((c) => c.inReplyTo === null);
			if (original) {
				lines.push(`${pad}    ${theme.fg("dim", `${original.author}:`)}`);
				for (const wl of wordWrap(original.body, wrapWidth - 6)) {
					lines.push(`${pad}      ${theme.fg("text", wl)}`);
				}
				lines.push("");
			}

			// LLM recommendation
			const analysis = threadAnalyses.get(thread.id);
			if (analysis) {
				lines.push(
					`${pad}    ${theme.fg("dim", "─".repeat(Math.min(30, wrapWidth - 6)))}`,
				);
				lines.push(
					`${pad}    ${theme.fg("accent", `Recommendation: ${analysis.recommendation}`)}`,
				);
				for (const wl of wordWrap(analysis.analysis, wrapWidth - 6)) {
					lines.push(`${pad}      ${theme.fg("dim", wl)}`);
				}
				lines.push("");
			}

			// Full conversation (if more than original)
			if (thread.comments.length > 1) {
				lines.push(`${pad}    ${theme.fg("dim", "Thread History:")}`);
				for (const comment of thread.comments) {
					const isOrig = comment.inReplyTo === null;
					const tag = isOrig ? "▸" : "  ↳";
					lines.push(
						`${pad}    ${theme.fg(isOrig ? "accent" : "muted", `${tag} ${comment.author}:`)}`,
					);
					for (const wl of wordWrap(comment.body, wrapWidth - 8)) {
						lines.push(`${pad}        ${theme.fg("dim", wl)}`);
					}
				}
				lines.push("");
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
