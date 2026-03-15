/**
 * PR Reply Extension
 *
 * Mode for responding to GitHub PR review feedback. The LLM
 * drives the workflow by calling pr_reply with different actions:
 *
 *   activate  — load PR, show summary, enter mode
 *   next      — present the next pending thread
 *   implement — mark current thread for implementation
 *   reply     — draft and post a reply to the current thread
 *   done      — mark implementation complete, link commits
 *   skip      — skip the current thread
 *   defer     — defer the current thread
 *   deactivate — exit PR reply mode
 *
 * Each call returns rich context about the thread, conversation,
 * and code location. The LLM reads this, analyzes the feedback,
 * and tells the user what it recommends — then calls back with
 * the chosen action.
 *
 * Coordinates with:
 *   - TDD mode (listens for tdd_phase done events)
 *   - Plan mode (shares plan directory configuration)
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import { prompt } from "../lib/ui/panel.js";
import { formatSteer } from "../lib/ui/steer.js";
import { buildAnalysisPrompt } from "./analysis.js";
import {
	fetchReviews,
	type PRReference,
	postReply,
	refreshThreadComments,
} from "./api/github.js";
import { parsePRReference } from "./api/parse.js";
import {
	findDependentPRs,
	findPRForBranch,
	getCurrentBranch,
	getCurrentRepo,
	type SwitchResult,
	switchToRepo,
} from "./api/repo.js";
import {
	beginTDDImplementation,
	buildImplementationContext,
	collectImplementationCommits,
	handleTDDCompletion,
	linkCommitsToThread,
	recordImplementationStart,
	shortSHAs,
} from "./implementation.js";
import {
	activate,
	deactivate,
	persist,
	refreshUI,
	restore,
	toggle,
} from "./lifecycle.js";
import { findPlanContext } from "./plans.js";
import { buildReplyGuidance } from "./replies.js";
import {
	createPRReplyState,
	sortReviewsByPriority,
	threadsForReview,
} from "./state.js";
import { buildPRReplyContext, prReplyContextFilter } from "./transitions.js";
import {
	type DependentPR,
	showRebasePanel,
	showReviewOverviewPanel,
	showSummaryPanel,
} from "./ui/panels.js";

/** Actions the LLM can request. */
const ACTIONS = [
	"activate",
	"deactivate",
	"next",
	"review",
	"show",
	"implement",
	"reply",
	"done",
	"skip",
	"defer",
] as const;

export default function prReply(pi: ExtensionAPI) {
	const state = createPRReplyState();

	// ---- Tool ----

	pi.registerTool({
		name: "pr_reply",
		label: "PR Reply",
		description:
			"Manage PR reply mode — respond to review feedback on a pull request. " +
			"Call with 'activate' to start, then 'next' to iterate threads. " +
			"For each thread, choose 'implement', 'reply', 'skip', or 'defer'. " +
			"After implementing changes, call 'done' to link commits and post a reply.",
		promptSnippet:
			"Respond to PR review feedback. " +
			"Read the pr-reply skill for methodology.",
		promptGuidelines: [
			"Use when the user wants to respond to PR reviews, address review feedback, or handle PR comments.",
			"Workflow: activate → next → review → next → show → (action) → next → ... → deactivate.",
			"'next' returns either a review summary (new reviewer) or thread data (same reviewer).",
			"When you get a review summary: analyze the review's character, then call 'review' with your analysis.",
			"When you get thread data: analyze the thread, then call 'show' with your recommendation.",
			"After the user approves 'implement': make changes, run tests, commit. Then call 'done' with a reply_body.",
			"After the user approves 'reply': call 'reply' with the reply_body text.",
			"The reply_body should be conversational, acknowledge feedback, and include commit SHAs inline if changes were made.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"activate: start mode | next: load next thread or review | " +
					"review: show review overview with analysis | " +
					"show: present thread gate with recommendation | " +
					"implement: begin implementing current thread | " +
					"reply: post a reply | done: finish implementation | " +
					"skip: skip thread | defer: defer thread | deactivate: exit mode",
			}),
			pr: Type.Optional(
				Type.String({
					description:
						"PR reference (URL, #number, owner/repo#number). Only used with 'activate'.",
				}),
			),
			analysis: Type.Optional(
				Type.String({
					description:
						"Your analysis text. For 'review': overall review character. " +
						"For 'show': thread recommendation. Supports markdown.",
				}),
			),
			reply_body: Type.Optional(
				Type.String({
					description:
						"Reply text to post. Used with 'reply' and 'done' actions.",
				}),
			),
			use_tdd: Type.Optional(
				Type.Boolean({
					description:
						"Whether to use TDD mode for implementation. Used with 'implement'.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "activate":
					return handleActivate(ctx, params.pr ?? null);
				case "deactivate":
					return handleDeactivate(ctx);
				case "next":
					return handleNext(ctx);
				case "review":
					return handleReview(ctx, params.analysis ?? "");
				case "show":
					return handleShow(ctx, params.analysis ?? "");
				case "implement":
					return handleImplement(params.use_tdd);
				case "reply":
					return handleReplyAction(ctx, params.reply_body ?? null);
				case "done":
					return handleDone(ctx, params.reply_body ?? null);
				case "skip":
					return handleSkip();
				case "defer":
					return handleDefer();
				default:
					return textResult(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, _options, theme) {
			const a = args as { action?: string; pr?: string };
			let text = theme.fg("toolTitle", theme.bold("pr_reply "));
			text += theme.fg("muted", a.action ?? "?");
			if (a.pr) {
				text += theme.fg("dim", ` ${a.pr}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(res, _options, theme) {
			const d = res.details as
				| { action?: string; threadCount?: number; openedTab?: boolean }
				| undefined;
			if (d?.openedTab) {
				return new Text(
					theme.fg("success", "↗ Opened new tab — this session is done"),
					0,
					0,
				);
			}
			if (d?.action === "activate" && d.threadCount) {
				return new Text(
					theme.fg("success", `✓ ${d.threadCount} threads loaded`),
					0,
					0,
				);
			}
			if (d?.action === "next") {
				return new Text(theme.fg("muted", "Thread loaded"), 0, 0);
			}
			if (d?.action === "replied") {
				return new Text(theme.fg("success", "✓ Reply posted"), 0, 0);
			}
			const t = res.content?.[0];
			const text = t && "text" in t ? t.text : "";
			const maxLen = 80;
			const truncated =
				text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
			return new Text(theme.fg("muted", truncated), 0, 0);
		},
	});

	// ---- Commands ----

	pi.registerCommand("pr-reply", {
		description: "Toggle PR reply mode",
		handler: async (_args, ctx) => toggle(state, pi, ctx),
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("r"), {
		description: "Toggle PR reply mode",
		handler: async (ctx) => toggle(state, pi, ctx),
	});

	// ---- TDD coordination ----

	pi.on("tool_result", async (event) => {
		if (!state.enabled || !state.awaitingTDDCompletion) return;
		if (event.toolName !== "tdd_phase") return;

		const details = event.details as { action?: string } | undefined;
		if (details?.action !== "done" && details?.action !== "stop") return;

		handleTDDCompletion(state);

		// Collect commits made during TDD
		const commits = await collectImplementationCommits(state, pi);
		if (state.tddThreadId) {
			linkCommitsToThread(state, state.tddThreadId, commits);
		}

		persist(state, pi);
	});

	// ---- Context ----

	pi.on("before_agent_start", async () => {
		return buildPRReplyContext(state);
	});

	pi.on("context", prReplyContextFilter(state));

	// ---- Restore ----

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});

	// ---- Action handlers ----

	/** Activate PR reply mode — load reviews and show summary. */
	async function handleActivate(ctx: ExtensionContext, prInput: string | null) {
		if (state.enabled) {
			return textResult(
				`PR reply mode is already active for PR #${state.prNumber}.`,
			);
		}

		const ref = await resolvePR(prInput);
		if (!ref) {
			return textResult(
				"Could not determine which PR to review. " +
					"Provide a PR URL, number, or navigate to the branch.",
			);
		}

		const switchResult = await switchToRepo(pi, ref);
		if (switchResult.status !== "already-here") {
			return handleSwitchResult(ctx, switchResult, ref);
		}

		// Ensure we're on the PR's branch
		const prBranch = await getPRBranch(ref);
		if (prBranch) {
			const currentBranch = await getCurrentBranch(pi);
			if (currentBranch !== prBranch) {
				const checkout = await pi.exec("git", ["checkout", prBranch]);
				if (checkout.code !== 0) {
					return textResult(
						`Failed to switch to branch '${prBranch}': ${checkout.stderr}\n` +
							`You're on '${currentBranch}'. Switch manually and retry.`,
					);
				}
				ctx.ui.notify(`Switched to branch ${prBranch}`, "info");
			}
		}

		ctx.ui.notify("Fetching reviews…", "info");
		const data = await fetchReviews(pi, ref);

		const dismissedCount = data.reviews.filter(
			(r) => r.state === "DISMISSED",
		).length;
		const activeReviews = data.reviews.filter((r) => r.state !== "DISMISSED");
		const unresolvedThreads = data.threads.filter((t) => !t.isResolved);

		if (unresolvedThreads.length === 0) {
			return textResult("No unresolved review threads to address.");
		}

		// Populate state
		state.prNumber = ref.number;
		state.owner = ref.owner;
		state.repo = ref.repo;
		state.branch =
			prBranch ?? (await getCurrentBranch(pi)) ?? `pr-${ref.number}`;
		// Only keep reviews that have unresolved threads
		const reviewsWithThreads = activeReviews.filter((r) =>
			r.threadIds.some((id) => unresolvedThreads.some((t) => t.id === id)),
		);

		// Sort by priority: CHANGES_REQUESTED → COMMENTED → APPROVED
		sortReviewsByPriority(reviewsWithThreads);
		state.reviews = reviewsWithThreads;
		state.threads = unresolvedThreads;
		state.reviewIndex = 0;
		state.reviewIntroduced = false;
		state.threadIndexInReview = 0;

		for (const thread of unresolvedThreads) {
			state.threadStates.set(thread.id, "pending");
		}

		activate(state, pi, ctx);

		// Show summary panel
		const proceed = await showSummaryPanel(
			ctx,
			ref.number,
			ref.owner,
			ref.repo,
			state.branch,
			activeReviews,
			unresolvedThreads,
			dismissedCount,
		);

		if (!proceed) {
			deactivate(state, pi, ctx);
			return textResult("PR reply cancelled.");
		}

		return {
			content: [
				{
					type: "text" as const,
					text: buildActivationSummary(
						ref,
						activeReviews.length,
						unresolvedThreads.length,
						dismissedCount,
					),
				},
			],
			details: {
				action: "activate",
				threadCount: unresolvedThreads.length,
				reviewCount: activeReviews.length,
			},
		};
	}

	/** Deactivate PR reply mode. */
	async function handleDeactivate(ctx: ExtensionContext) {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		// Check for dependent PRs before exiting
		const rebaseInfo = await checkDependentPRs(ctx);

		deactivate(state, pi, ctx);

		const summary = buildCompletionSummary();
		const text = rebaseInfo ? `${summary}\n\n${rebaseInfo}` : summary;

		return textResult(text);
	}

	/**
	 * Advance to the next item in the review → thread cascade.
	 *
	 * Navigation order:
	 *   1. Reviews sorted by priority (CHANGES_REQUESTED → COMMENTED → APPROVED)
	 *   2. Within each review, threads sorted by file then line
	 *   3. When entering a new review, return review summary
	 *   4. When within a review, return next thread data
	 */
	async function handleNext(ctx: ExtensionContext) {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		// Walk reviews starting from current position
		while (state.reviewIndex < state.reviews.length) {
			const review = state.reviews[state.reviewIndex];
			if (!review) break;

			// If this review hasn't been introduced yet, return its summary
			if (!state.reviewIntroduced) {
				const reviewThreads = threadsForReview(review, state.threads);
				const pendingThreads = reviewThreads.filter(
					(t) => state.threadStates.get(t.id) === "pending",
				);

				// Skip reviews with no pending threads
				if (pendingThreads.length === 0) {
					state.reviewIndex++;
					continue;
				}

				state.reviewIntroduced = true;
				state.threadIndexInReview = 0;
				refreshUI(state, ctx);
				persist(state, pi);

				const parts: string[] = [];
				parts.push(`## Review from ${review.author}`);
				parts.push(`**State**: ${review.state}`);
				parts.push(`**Submitted**: ${review.submittedAt}`);
				parts.push(`**Threads**: ${pendingThreads.length}`);
				if (review.body) {
					parts.push("");
					parts.push("### Review Comment");
					parts.push(review.body);
				}
				parts.push("");
				parts.push("### Threads in This Review");
				for (const t of pendingThreads) {
					const snippet =
						t.comments[0]?.body.slice(0, 60).replace(/\n/g, " ") ?? "";
					const ellipsis = (t.comments[0]?.body.length ?? 0) > 60 ? "…" : "";
					parts.push(`  • ${t.file}:${t.line} — ${snippet}${ellipsis}`);
				}
				parts.push("");
				parts.push(
					"Analyze the character of this review — is it thorough, nitpicky, " +
						"collaborative, blocking? Then call pr_reply with action 'review' " +
						"and your analysis as the 'analysis' parameter.",
				);

				return {
					content: [{ type: "text" as const, text: parts.join("\n") }],
					details: {
						action: "review-summary",
						reviewId: review.id,
						reviewer: review.author,
					},
				};
			}

			// Review already introduced — find next pending thread within it
			const reviewThreads = threadsForReview(review, state.threads);
			const nextThread = findNextPendingInReview(reviewThreads);

			if (!nextThread) {
				// Done with this review — advance to next
				state.reviewIndex++;
				state.reviewIntroduced = false;
				state.threadIndexInReview = 0;
				continue;
			}

			// Found a thread — return its data
			state.threadIndexInReview = reviewThreads.indexOf(nextThread);
			refreshUI(state, ctx);
			persist(state, pi);

			// Re-fetch comments
			if (state.owner && state.repo && state.prNumber) {
				await refreshThreadComments(
					pi,
					{ owner: state.owner, repo: state.repo, number: state.prNumber },
					nextThread,
				);
				if (nextThread.isResolved) {
					state.threadStates.set(nextThread.id, "skipped");
					persist(state, pi);
					return handleNext(ctx);
				}
			}

			const contextLine = nextThread.line || nextThread.originalLine || 0;
			const codeContext =
				contextLine > 0
					? await readCodeContext(nextThread.file, contextLine)
					: null;
			const planContext = findPlanContext(ctx.cwd, nextThread.file);

			const analysisContext = buildAnalysisPrompt(
				nextThread,
				review,
				codeContext,
				planContext,
			);

			const progress = buildProgressSummary();

			return {
				content: [
					{
						type: "text" as const,
						text:
							`${progress}\n\n${analysisContext}\n\n` +
							"Analyze this thread critically. Don't just agree with the reviewer — evaluate " +
							"whether their suggestion actually improves the code. If the user already " +
							"addressed the feedback or pushed back with good reasoning, say so. " +
							"Then call pr_reply with action 'show' and your recommendation " +
							"(as the 'analysis' parameter).",
					},
				],
				details: {
					action: "next",
					threadId: nextThread.id,
					file: nextThread.file,
					line: contextLine,
				},
			};
		}

		// All reviews exhausted
		const deferredCount = countByState("deferred");
		if (deferredCount > 0) {
			return textResult(
				`All reviews complete. ${deferredCount} deferred thread${deferredCount !== 1 ? "s" : ""} remaining.\n\n` +
					"To revisit deferred threads, the user can say 'handle deferred threads' " +
					"and you should reset them to pending.\n\n" +
					"Otherwise, call pr_reply with action 'deactivate' to finish.",
			);
		}
		return textResult(
			"All reviews and threads addressed. Call pr_reply with action 'deactivate' to finish.",
		);
	}

	/** Find the next pending thread within a review's threads. */
	function findNextPendingInReview(reviewThreads: Thread[]): Thread | null {
		for (const thread of reviewThreads) {
			if (state.threadStates.get(thread.id) === "pending") {
				return thread;
			}
		}
		return null;
	}

	/**
	 * Show the decision gate for the current thread with the
	 * LLM's analysis and recommendation.
	 *
	 * Two tabs:
	 *   Action — original comment, code context, analysis, recommendation, action options
	 *   Thread — full conversation history (read-only)
	 */
	/**
	 * Show the review overview panel with the LLM's analysis
	 * of the review's character. User confirms to proceed.
	 */
	async function handleReview(ctx: ExtensionContext, analysis: string) {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		const review = state.reviews[state.reviewIndex];
		if (!review) {
			return textResult("No active review. Call 'next' first.");
		}

		const pendingThreads = threadsForReview(review, state.threads).filter(
			(t) => state.threadStates.get(t.id) === "pending",
		);

		const proceed = await showReviewOverviewPanel(
			ctx,
			review,
			pendingThreads,
			analysis,
		);

		if (!proceed) {
			// Skip all threads in this review
			for (const t of pendingThreads) {
				state.threadStates.set(t.id, "skipped");
			}
			persist(state, pi);
			return textResult(
				`Skipped review from ${review.author} (${pendingThreads.length} threads). ` +
					"Call 'next' to continue.",
			);
		}

		return textResult(
			`Review from ${review.author} acknowledged. ` +
				`${pendingThreads.length} thread${pendingThreads.length !== 1 ? "s" : ""} to review. ` +
				"Call 'next' to start.",
		);
	}

	async function handleShow(ctx: ExtensionContext, recommendation: string) {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		const thread = currentThread();
		if (!thread) {
			return textResult("No current thread. Call 'next' first.");
		}

		const review = state.reviews.find((r) => r.threadIds.includes(thread.id));
		const contextLine = thread.line || thread.originalLine || 0;
		const progress = buildProgressSummary();
		const original = thread.comments.find((c) => c.inReplyTo === null);

		const codeContext =
			contextLine > 0 ? await readCodeContext(thread.file, contextLine) : null;

		const steerContext = buildAnalysisPrompt(
			thread,
			review ?? state.reviews[0],
			codeContext,
			null,
		);

		const promptResult = await prompt(ctx, {
			content: (theme, width) => {
				const lines: string[] = [];

				// Header
				lines.push(theme.fg("accent", theme.bold(progress)));
				lines.push(
					theme.fg(
						"muted",
						`${thread.file}:${contextLine} • ${review?.author ?? thread.reviewer} • ${thread.reviewState}`,
					),
				);
				lines.push("");

				// Original comment
				if (original) {
					lines.push(theme.fg("dim", `${original.author}:`));
					lines.push(...renderMarkdown(original.body, theme, width));
					lines.push("");
				}

				// Code context
				if (codeContext) {
					lines.push("```");
					lines.push(codeContext);
					lines.push("```");
					lines.push("");
				}

				// LLM analysis and recommendation
				if (recommendation) {
					lines.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
					lines.push("");
					lines.push(...renderMarkdown(recommendation, theme, width));
				}

				// Full thread conversation (if more than just the original)
				if (thread.comments.length > 1) {
					lines.push("");
					lines.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
					lines.push(theme.fg("dim", "Thread History:"));
					lines.push("");
					for (const comment of thread.comments) {
						const isOrig = comment.inReplyTo === null;
						const tag = isOrig ? "▸" : "  ↳";
						lines.push(
							theme.fg(
								isOrig ? "accent" : "muted",
								`${tag} ${comment.author} (${comment.createdAt}):`,
							),
						);
						lines.push(...renderMarkdown(comment.body, theme, width));
						lines.push("");
					}
				}

				return lines;
			},
			actions: [
				{ key: "i", label: "Implement Now" },
				{ key: "l", label: "Implement Later" },
				{ key: "r", label: "Reply" },
				{ key: "d", label: "Defer" },
				{ key: "k", label: "sKip" },
			],
		});

		// Map prompt result to gate-style result for handleThreadChoice
		const gateResult = promptResult
			? promptResult.type === "steer"
				? { value: "steer", feedback: promptResult.note }
				: {
						value:
							promptResult.value === "i"
								? "implement"
								: promptResult.value === "l"
									? "implement-later"
									: promptResult.value === "r"
										? "reply"
										: promptResult.value === "d"
											? "defer"
											: "skip",
						feedback: promptResult.note,
					}
			: null;

		return handleThreadChoice(gateResult, thread, contextLine, steerContext);
	}

	/** Mark current thread for implementation and provide context. */
	async function handleImplement(useTDD?: boolean) {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		const thread = currentThread();
		if (!thread) {
			return textResult("No current thread. Call 'next' first.");
		}

		await recordImplementationStart(state, pi);
		state.threadStates.set(thread.id, "implementing");

		if (useTDD) {
			beginTDDImplementation(state, thread);
			persist(state, pi);

			return textResult(
				"Thread marked for TDD implementation.\n\n" +
					`${buildImplementationContext(thread)}\n\n` +
					"Start TDD mode with tdd_phase action 'start'. " +
					"When TDD is done, call pr_reply with action 'done' " +
					"and a reply_body to post.",
			);
		}

		persist(state, pi);

		return textResult(
			"Thread marked for direct implementation.\n\n" +
				`${buildImplementationContext(thread)}\n\n` +
				"Make the necessary changes, run tests, and commit. " +
				"Then call pr_reply with action 'done' and a reply_body to post.",
		);
	}

	/** Post a reply to the current thread (no code changes). */
	async function handleReplyAction(
		ctx: ExtensionContext,
		replyBody: string | null,
	) {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		const thread = currentThread();
		if (!thread) {
			return textResult("No current thread. Call 'next' first.");
		}

		if (!replyBody) {
			return textResult("Provide reply_body with the text to post as a reply.");
		}

		return reviewAndPostReply(ctx, thread, replyBody);
	}

	/**
	 * Mark implementation as done — collect commits, post reply.
	 * Called after the LLM has made changes and committed.
	 */
	async function handleDone(ctx: ExtensionContext, replyBody: string | null) {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		const thread = currentThread();
		if (!thread) {
			return textResult("No current thread.");
		}

		// Collect commits since implementation started
		const commits = await collectImplementationCommits(state, pi);
		linkCommitsToThread(state, thread.id, commits);

		if (!replyBody && commits.length > 0) {
			const guidance = buildReplyGuidance(thread, commits);
			return textResult(
				`Found ${commits.length} commit${commits.length !== 1 ? "s" : ""}.\n\n` +
					`${guidance}\n\n` +
					"Call pr_reply with action 'done' again, this time with a reply_body.",
			);
		}

		if (replyBody) {
			const replyResult = await reviewAndPostReply(ctx, thread, replyBody);

			// If the reply failed or was steered, return that result
			const replyDetails = replyResult.details as
				| { action?: string }
				| undefined;
			if (replyDetails?.action !== "replied") {
				state.threadStates.set(thread.id, "addressed");
				persist(state, pi);
				return replyResult;
			}
		} else {
			state.threadStates.set(thread.id, "addressed");
		}

		state.awaitingTDDCompletion = false;
		state.tddThreadId = null;
		state.implementationStartSHA = null;
		persist(state, pi);

		const commitInfo =
			commits.length > 0
				? `${commits.length} commit${commits.length !== 1 ? "s" : ""} linked.`
				: "No new commits detected.";

		return {
			content: [
				{
					type: "text" as const,
					text: `Thread done. ${commitInfo} Call 'next' to continue.`,
				},
			],
			details: {
				action: "done",
				threadId: thread.id,
				commits: shortSHAs(commits),
			},
		};
	}

	/** Skip the current thread. */
	function handleSkip() {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		const thread = currentThread();
		if (!thread) {
			return textResult("No current thread. Call 'next' first.");
		}

		state.threadStates.set(thread.id, "skipped");
		persist(state, pi);

		return textResult("Thread skipped. Call 'next' to continue.");
	}

	/** Defer the current thread for later. */
	function handleDefer() {
		if (!state.enabled) {
			return textResult("PR reply mode is not active.");
		}

		const thread = currentThread();
		if (!thread) {
			return textResult("No current thread. Call 'next' first.");
		}

		state.threadStates.set(thread.id, "deferred");
		persist(state, pi);

		return textResult("Thread deferred. Call 'next' to continue.");
	}

	// ---- Helpers ----

	/** Get the thread at the current index. */
	/**
	 * Review a reply via the standard approve/edit/steer gate,
	 * then post it to GitHub.
	 */
	async function reviewAndPostReply(
		ctx: ExtensionContext,
		thread: (typeof state.threads)[number],
		draftReply: string,
	) {
		if (!state.owner || !state.repo || !state.prNumber) {
			return textResult("Missing PR context.");
		}

		const topComment = thread.comments.find((c) => c.inReplyTo === null);
		if (!topComment) {
			return textResult("Cannot find original comment to reply to.");
		}

		const replyResult = await prompt(ctx, {
			content: (theme: Theme, width: number) => {
				const lines: string[] = [];
				lines.push(
					theme.fg(
						"dim",
						`Replying to ${topComment.author} on ${thread.file}:${thread.line}`,
					),
				);
				lines.push("");
				lines.push(...renderMarkdown(draftReply, theme, width));
				return lines;
			},
			actions: [
				{ key: "a", label: "Approve" },
				{ key: "r", label: "Reject" },
			],
		});

		// If user cancelled, rejected, or steered — return that to the LLM
		if (!replyResult) {
			return {
				content: [
					{
						type: "text" as const,
						text: "User cancelled the reply review.",
					},
				],
				details: { action: "reply-rejected" },
			};
		}
		if (replyResult.type === "steer") {
			const steerResult = formatSteer(
				replyResult.note,
				`Original reply:\n${draftReply}`,
			);
			return {
				content: [{ type: "text" as const, text: steerResult.reason }],
				details: { action: "reply-rejected" },
			};
		}
		if (replyResult.type === "action" && replyResult.value === "r") {
			const reason = replyResult.note
				? `User rejected: ${replyResult.note}`
				: "User rejected the reply. Ask for guidance on the reply.";
			return {
				content: [{ type: "text" as const, text: reason }],
				details: { action: "reply-rejected" },
			};
		}

		// Push any unpushed commits before posting (SHAs must resolve on GitHub)
		await pushIfNeeded(pi);

		// Post the reply
		const ref: PRReference = {
			owner: state.owner,
			repo: state.repo,
			number: state.prNumber,
		};

		try {
			await postReply(pi, ref, topComment.databaseId, draftReply);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return textResult(`Failed to post reply: ${msg}`);
		}

		state.threadStates.set(thread.id, "replied");
		persist(state, pi);

		return {
			content: [
				{
					type: "text" as const,
					text: "Reply posted. Call 'next' to continue.",
				},
			],
			details: { action: "replied", threadId: thread.id },
		};
	}

	/** Get the thread at the current index. */
	/** Get the current thread based on review-centric navigation. */
	function currentThread() {
		const review = state.reviews[state.reviewIndex];
		if (!review) return null;
		const reviewThreads = threadsForReview(review, state.threads);
		return reviewThreads[state.threadIndexInReview] ?? null;
	}

	/** Map the user's gate choice to a tool result for the LLM. */
	function handleThreadChoice(
		gateResult: { value: string; feedback?: string } | null,
		thread: (typeof state.threads)[number],
		contextLine: number,
		analysisContext: string,
	) {
		if (!gateResult) {
			state.threadStates.set(thread.id, "deferred");
			persist(state, pi);
			return textResult(
				"Thread deferred (cancelled). Call pr_reply with action 'next' to continue.",
			);
		}

		const choice = gateResult.value;

		if (choice === "steer") {
			return {
				content: [
					{
						type: "text" as const,
						text:
							`User feedback on thread ${thread.file}:${contextLine}:\n\n` +
							`${gateResult.feedback}\n\n` +
							`Thread context:\n${analysisContext}\n\n` +
							"Interpret the user's feedback and call pr_reply with the appropriate " +
							"action (implement, reply, skip, or defer). If they want a reply composed, " +
							"call pr_reply with action 'reply' and a reply_body.",
					},
				],
				details: { action: "next", steered: true, threadId: thread.id },
			};
		}

		if (choice === "skip") {
			state.threadStates.set(thread.id, "skipped");
			persist(state, pi);
			return textResult(
				"Thread skipped. Call pr_reply with action 'next' to continue.",
			);
		}

		if (choice === "defer" || choice === "implement-later") {
			state.threadStates.set(thread.id, "deferred");
			persist(state, pi);
			const label =
				choice === "implement-later"
					? "deferred for later implementation"
					: "deferred";
			return textResult(
				`Thread ${label}. Call pr_reply with action 'next' to continue.`,
			);
		}

		if (choice === "reply") {
			return {
				content: [
					{
						type: "text" as const,
						text:
							`User chose to reply to thread on ${thread.file}:${contextLine}.\n\n` +
							`Thread context:\n${analysisContext}\n\n` +
							"Compose a reply and call pr_reply with action 'reply' and a reply_body. " +
							"The reply should be conversational, acknowledge the feedback, and be brief.",
					},
				],
				details: { action: "next", chosen: "reply", threadId: thread.id },
			};
		}

		// choice === "implement"
		return {
			content: [
				{
					type: "text" as const,
					text:
						`User chose to implement changes for thread on ${thread.file}:${contextLine}.\n\n` +
						`Thread context:\n${analysisContext}\n\n` +
						"Recommend whether to use TDD based on the change scope. " +
						"Then call pr_reply with action 'implement' (and use_tdd if appropriate). " +
						"After making changes and committing, call pr_reply with action 'done' and a reply_body.",
				},
			],
			details: { action: "next", chosen: "implement", threadId: thread.id },
		};
	}

	/** Find the index of the next pending thread. */

	/** Resolve a PR reference from user input or current branch. */
	async function resolvePR(
		prInput: string | null,
	): Promise<PRReference | null> {
		if (prInput) {
			const currentRepo = await getCurrentRepo(pi);
			const ref = parsePRReference(
				prInput,
				currentRepo?.owner,
				currentRepo?.repo,
			);
			if (ref) return ref;
		}

		const currentRepo = await getCurrentRepo(pi);
		const currentBranch = await getCurrentBranch(pi);

		if (currentRepo && currentBranch) {
			const prNumber = await findPRForBranch(
				pi,
				currentRepo.owner,
				currentRepo.repo,
				currentBranch,
			);

			if (prNumber) {
				return {
					owner: currentRepo.owner,
					repo: currentRepo.repo,
					number: prNumber,
				};
			}
		}

		return null;
	}

	/**
	 * Read code context from disk around the commented line.
	 * Returns null if the file can't be read.
	 */
	async function readCodeContext(
		filePath: string,
		line: number,
	): Promise<string | null> {
		const contextLines = 5;
		const startLine = Math.max(1, line - contextLines);
		const endLine = line + contextLines;

		const result = await pi.exec("sed", [
			"-n",
			`${startLine},${endLine}p`,
			filePath,
		]);

		if (result.code !== 0 || !result.stdout) return null;

		// Add line numbers
		const lines = result.stdout.split("\n");
		const numbered = lines.map((l, i) => {
			const lineNum = startLine + i;
			const marker = lineNum === line ? "→" : " ";
			return `${marker}${String(lineNum).padStart(4)} │ ${l}`;
		});

		return numbered.join("\n");
	}

	/**
	 * Check for dependent PRs and offer to rebase them.
	 * Returns instructions for the LLM, or null if nothing to do.
	 */
	/**
	 * Walk the full dependency chain and offer to rebase.
	 * Follows: current branch → PRs based on it → PRs based on those → ...
	 */
	async function checkDependentPRs(
		ctx: ExtensionContext,
	): Promise<string | null> {
		if (!state.owner || !state.repo || !state.branch) return null;

		const chain = await walkDependencyChain(
			state.owner,
			state.repo,
			state.branch,
		);
		if (chain.length === 0) return null;

		const choice = await showRebasePanel(ctx, chain);

		if (choice === "rebase") {
			const prList = chain.map((d) => `#${d.number} (${d.branch})`).join(" → ");
			return (
				`User approved rebasing the PR chain: ${prList}.\n` +
				"Rebase each branch in order onto its updated base, " +
				"then force-push each one. Handle conflicts using the rebase skill."
			);
		}

		return null;
	}

	/**
	 * Recursively find all PRs in the dependency chain.
	 * Returns them in rebase order (closest dependent first).
	 */
	async function walkDependencyChain(
		owner: string,
		repo: string,
		branch: string,
	): Promise<DependentPR[]> {
		const chain: DependentPR[] = [];
		const visited = new Set<string>();
		let currentBranch = branch;

		while (true) {
			if (visited.has(currentBranch)) break; // Cycle protection
			visited.add(currentBranch);

			const dependentNumbers = await findDependentPRs(
				pi,
				owner,
				repo,
				currentBranch,
			);
			if (dependentNumbers.length === 0) break;

			// Take the first dependent (stacks are linear chains)
			const info = await fetchPRInfo(owner, repo, dependentNumbers[0]);
			chain.push(info);
			currentBranch = info.branch;
		}

		return chain;
	}

	/** Fetch basic info about a PR. */
	async function fetchPRInfo(
		owner: string,
		repo: string,
		prNumber: number,
	): Promise<DependentPR> {
		const result = await pi.exec("gh", [
			"pr",
			"view",
			String(prNumber),
			"--repo",
			`${owner}/${repo}`,
			"--json",
			"number,title,headRefName",
		]);

		if (result.code === 0) {
			try {
				const data = JSON.parse(result.stdout);
				return {
					number: data.number ?? prNumber,
					title: data.title ?? `PR #${prNumber}`,
					branch: data.headRefName ?? "unknown",
				};
			} catch {
				/* Parse failure — fall through to default */
			}
		}

		return { number: prNumber, title: `PR #${prNumber}`, branch: "unknown" };
	}

	/** Build summary text after activation. */
	function buildActivationSummary(
		ref: PRReference,
		reviewCount: number,
		threadCount: number,
		dismissedCount: number,
	): string {
		const parts = [
			`PR reply mode activated for ${ref.owner}/${ref.repo}#${ref.number}.`,
			`${threadCount} unresolved thread${threadCount !== 1 ? "s" : ""} across ${reviewCount} review${reviewCount !== 1 ? "s" : ""}.`,
		];

		if (dismissedCount > 0) {
			parts.push(
				`${dismissedCount} dismissed review${dismissedCount !== 1 ? "s" : ""} filtered.`,
			);
		}

		parts.push("Call pr_reply with action 'next' to start reviewing threads.");

		return parts.join(" ");
	}

	/** Build progress summary for thread navigation. */
	function buildProgressSummary(): string {
		const review = state.reviews[state.reviewIndex];
		const reviewLabel = review
			? `Review ${state.reviewIndex + 1}/${state.reviews.length} (${review.author})`
			: `Review ?/${state.reviews.length}`;

		const done =
			countByState("replied") +
			countByState("addressed") +
			countByState("skipped");
		const total = state.threads.length;

		return `[PR #${state.prNumber} • ${reviewLabel} • ${done}/${total} threads done]`;
	}

	/** Build completion summary when deactivating. */
	function buildCompletionSummary(): string {
		const total = state.threads.length;
		const replied = countByState("replied");
		const addressed = countByState("addressed");
		const deferred = countByState("deferred");
		const skipped = countByState("skipped");

		return (
			`PR reply complete for #${state.prNumber}. ` +
			`${replied} replied, ${addressed} addressed, ` +
			`${deferred} deferred, ${skipped} skipped ` +
			`out of ${total} thread${total !== 1 ? "s" : ""}.`
		);
	}

	/** Count threads in a given state. */
	/** Get the head branch name for a PR from GitHub. */
	async function getPRBranch(ref: PRReference): Promise<string | null> {
		const result = await pi.exec("gh", [
			"pr",
			"view",
			String(ref.number),
			"--repo",
			`${ref.owner}/${ref.repo}`,
			"--json",
			"headRefName",
			"--jq",
			".headRefName",
		]);
		if (result.code !== 0 || !result.stdout.trim()) return null;
		return result.stdout.trim();
	}

	/**
	 * Push to the remote if there are unpushed commits.
	 * Compares local HEAD to the remote tracking branch.
	 */
	async function pushIfNeeded(p: ExtensionAPI): Promise<void> {
		// Check if there are commits ahead of the remote
		const status = await p.exec("git", [
			"rev-list",
			"--count",
			"@{upstream}..HEAD",
		]);

		const ahead = Number.parseInt(status.stdout.trim(), 10);
		if (Number.isNaN(ahead) || ahead === 0) return;

		const push = await p.exec("git", ["push"]);
		if (push.code !== 0) {
			// Non-fatal — warn but continue
			// The reply will still be posted, SHAs just won't be clickable yet
		}
	}

	function countByState(threadState: string): number {
		let count = 0;
		for (const [, value] of state.threadStates) {
			if (value === threadState) count++;
		}
		return count;
	}
}

/**
 * Handle the result of attempting to switch repositories.
 * Returns a tool result that clearly tells the LLM what happened.
 */
function handleSwitchResult(
	ctx: ExtensionContext,
	result: SwitchResult,
	ref: PRReference,
) {
	switch (result.status) {
		case "opened-tab":
			ctx.ui.notify(
				`Opened new tab in ${result.repoPath} for PR #${ref.number}.`,
				"success",
			);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`This session is not in the ${ref.owner}/${ref.repo} repository. ` +
							`A new terminal tab has been opened in ${result.repoPath} with pi ` +
							`already starting the PR reply workflow for #${ref.number}. ` +
							"Do NOT call pr_reply again in this session — the new tab is handling it. " +
							"Tell the user to switch to the new tab.",
					},
				],
				details: { openedTab: true, repoPath: result.repoPath },
			};

		case "not-found-opened-tab-failed":
			return textResult(
				`Found ${ref.owner}/${ref.repo} at ${result.repoPath} but could not open a new tab. ` +
					`The user should run: cd ${result.repoPath} && pi "respond to reviews on ${ref.owner}/${ref.repo}#${ref.number}"`,
			);

		case "not-found":
			return textResult(
				`Repository ${ref.owner}/${ref.repo} was not found on disk. ` +
					"Ask the user where the repository is located.",
			);

		default:
			return textResult("Unexpected state.");
	}
}

/** Build a simple text tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}
