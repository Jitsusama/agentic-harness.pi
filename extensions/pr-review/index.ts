/**
 * PR Review Extension
 *
 * Mode for reviewing someone else's pull request. The LLM drives
 * the workflow by calling pr_review with different actions:
 *
 *   activate     — parse PR ref, create worktree, gather context
 *   context      — show context summary (re-showable any time)
 *   description  — review PR description & scope
 *   analyze      — run deep analysis, return to conversation
 *   review-files — enter file-by-file review
 *   next-file    — advance to the next file
 *   add-comment  — add a review comment
 *   resume       — return to current phase after conversation
 *   vet          — enter final vetting phase
 *   post         — post the review to GitHub
 *   deactivate   — clean up and exit
 *
 * Each action returns structured context for the LLM to reason
 * about. The LLM reads it, presents findings, and calls back
 * with the next action.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { progress } from "../lib/ui/progress.js";
import {
	assembleContext,
	fetchDiff,
	fetchPRGraphQL,
	fetchPreviousReviews,
	fetchSiblingPRs,
	getCurrentUser,
	postReview,
} from "./api/github.js";
import type { PRReference } from "./api/parse.js";
import { extractOwnerRepo, parsePRReference } from "./api/parse.js";
import {
	activate,
	deactivate,
	persist,
	refreshUI,
	restore,
} from "./lifecycle.js";
import {
	addComment,
	commentsByStatus,
	createSession,
	createState,
	type DiffFile,
	type LinkedIssue,
	type ReviewSession,
} from "./state.js";
import { buildPRReviewContext, prReviewContextFilter } from "./transitions.js";
import { showContextSummary } from "./ui/context-summary.js";
import { showDescriptionReview } from "./ui/description.js";
import { showFileReview } from "./ui/file-review.js";
import { showVetting } from "./ui/vetting.js";
import { createWorktree, isOnPRBranch, removeWorktree } from "./worktree.js";

/** Actions the LLM can request. */
const ACTIONS = [
	"activate",
	"context",
	"description",
	"analyze",
	"review-files",
	"next-file",
	"add-comment",
	"resume",
	"vet",
	"post",
	"deactivate",
] as const;

export default function prReview(pi: ExtensionAPI) {
	const state = createState();

	// ---- Tool ----

	pi.registerTool({
		name: "pr_review",
		label: "PR Review",
		description:
			"Review someone else's pull request. Gathers context from the PR, " +
			"linked issues, and codebase, then guides a structured review through " +
			"description evaluation, deep analysis, and file-by-file comment collection. " +
			"Call with 'activate' to start reviewing a PR.",
		promptSnippet:
			"Review a pull request. " + "Read the pr-review skill for methodology.",
		promptGuidelines: [
			"Use when the user wants to review someone else's PR, do a code review, or provide PR feedback.",
			"Workflow: activate → context → description → analyze → review-files → vet → post → deactivate.",
			"After activate, call 'context' to show the gathered context summary.",
			"Call 'description' to review the PR title, description, and scope.",
			"Call 'analyze' to get context for deep analysis — then investigate the codebase yourself.",
			"Call 'review-files' to start file-by-file review. Use 'next-file' to advance.",
			"Use 'add-comment' to add review comments with conventional comments format.",
			"Call 'vet' to enter final vetting. Call 'post' to submit the review.",
			"The user can break out to conversation at any point. Call 'resume' to return.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"activate: start review | context: show context summary | " +
					"description: review PR description | analyze: deep analysis | " +
					"review-files: file-by-file review | next-file: next file | " +
					"add-comment: add a comment | resume: return to current phase | " +
					"vet: final vetting | post: submit review | deactivate: exit",
			}),
			pr: Type.Optional(
				Type.String({
					description:
						"PR reference (URL, #number, owner/repo#number). Only used with 'activate'.",
				}),
			),
			comment: Type.Optional(
				Type.Object(
					{
						file: Type.String({ description: "File path" }),
						startLine: Type.Number({ description: "Start line number" }),
						endLine: Type.Number({ description: "End line number" }),
						label: Type.String({ description: "Conventional comment label" }),
						decorations: Type.Array(Type.String(), {
							description: "Comment decorations (blocking, non-blocking, etc.)",
						}),
						subject: Type.String({ description: "Comment subject line" }),
						discussion: Type.String({
							description: "Comment discussion body",
						}),
					},
					{
						description:
							"Structured comment data. Used with 'add-comment' action.",
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "activate":
					return handleActivate(ctx, params.pr ?? null);
				case "context":
					return handleContext(ctx);
				case "description":
					return handleDescription(ctx);
				case "analyze":
					return handleAnalyze(ctx);
				case "review-files":
					return handleReviewFiles(ctx);
				case "next-file":
					return handleNextFile(ctx);
				case "add-comment":
					return handleAddComment(params.comment);
				case "resume":
					return handleResume(ctx);
				case "vet":
					return handleVet(ctx);
				case "post":
					return handlePost();
				case "deactivate":
					return handleDeactivate(ctx);
				default:
					return textResult(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme) {
			const a = args as { action?: string; pr?: string };
			let text = theme.fg("toolTitle", theme.bold("pr_review "));
			text += theme.fg("muted", a.action ?? "?");
			if (a.pr) {
				text += theme.fg("dim", ` ${a.pr}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(res, _options, theme) {
			const d = res.details as
				| { action?: string; phase?: string; fileCount?: number }
				| undefined;
			if (d?.action === "activate" && d.fileCount) {
				return new Text(
					theme.fg("success", `✓ ${d.fileCount} files, context gathered`),
					0,
					0,
				);
			}
			if (d?.action === "posted") {
				return new Text(theme.fg("success", "✓ Review posted"), 0, 0);
			}
			if (d?.action === "deactivated") {
				return new Text(theme.fg("muted", "Review complete"), 0, 0);
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

	pi.registerCommand("pr-review", {
		description: "Toggle PR review mode",
		handler: async (_args, ctx) => {
			if (state.enabled) {
				deactivate(state, pi, ctx);
				ctx.ui.notify("PR review mode off.");
			} else {
				ctx.ui.notify(
					"PR review mode requires activation via the pr_review tool.",
					"warning",
				);
			}
		},
	});

	// ---- Keyboard shortcut ----

	pi.registerShortcut(Key.ctrlAlt("v"), {
		description: "Deactivate PR review mode",
		handler: async (ctx) => {
			if (state.enabled) {
				deactivate(state, pi, ctx);
				ctx.ui.notify("PR review mode off.");
			}
		},
	});

	// ---- Context injection ----

	pi.on("before_agent_start", async () => {
		return buildPRReviewContext(state);
	});

	pi.on("context", prReviewContextFilter(state));

	// ---- Session restore ----

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});

	// ---- Helpers ----

	/**
	 * Ensure gathered context is available. If the session was
	 * restored but context was lost (too large for appendEntry),
	 * re-fetch it from GitHub transparently.
	 */
	async function ensureContext(ctx: ExtensionContext): Promise<boolean> {
		const session = state.session;
		if (!session) return false;
		if (session.context) return true;

		const { pr } = session;
		const ref: PRReference = {
			owner: pr.owner,
			repo: pr.repo,
			number: pr.number,
		};

		ctx.ui.notify("Re-fetching PR context…", "info");

		try {
			const [graphqlData, diff] = await Promise.all([
				fetchPRGraphQL(pi, ref),
				fetchDiff(pi, ref),
			]);

			session.context = assembleContext(
				graphqlData.pr,
				diff,
				graphqlData.prComments,
				graphqlData.issues,
				[],
			);
			return true;
		} catch {
			/* Re-fetch failed — context unavailable */
			return false;
		}
	}

	/** Resolve a PR reference from user input or current branch. */
	async function resolvePR(
		prInput: string | null,
	): Promise<PRReference | null> {
		const currentRepo = await getCurrentRepo(pi);

		if (prInput) {
			const ref = parsePRReference(
				prInput,
				currentRepo?.owner,
				currentRepo?.repo,
			);
			if (ref) return ref;
		}

		return null;
	}

	// ---- Action handlers ----

	/** Activate PR review — gather context with live progress. */
	async function handleActivate(ctx: ExtensionContext, prInput: string | null) {
		if (state.enabled) {
			return textResult(
				`PR review is already active for #${state.session?.pr.number}. ` +
					"Call 'deactivate' first to start a new review.",
			);
		}

		const ref = await resolvePR(prInput);
		if (!ref) {
			return textResult(
				"Could not determine which PR to review. " +
					"Provide a PR URL, number (#123), or owner/repo#number.",
			);
		}

		state.phase = "gathering";
		state.enabled = true;
		activate(state, pi, ctx);

		// Shared state for tasks that depend on each other.
		// The sibling PRs task waits for the GraphQL task to
		// populate fetchedIssues before searching.
		let fetchedIssues: LinkedIssue[] = [];
		let graphqlDone: () => void;
		const graphqlReady = new Promise<void>((resolve) => {
			graphqlDone = resolve;
		});

		const results = await progress(
			ctx,
			{ title: `Gathering context for PR #${ref.number}…` },
			[
				{
					label: "PR metadata & issues",
					run: async () => {
						const data = await fetchPRGraphQL(pi, ref);
						fetchedIssues = data.issues;
						graphqlDone();
						return data;
					},
				},
				{
					label: "Diff",
					run: async () => fetchDiff(pi, ref),
				},
				{
					label: "Sibling PRs",
					run: async () => {
						await graphqlReady;
						return fetchSiblingPRs(pi, ref, fetchedIssues);
					},
				},
				{
					label: "Previous reviews",
					run: async () => {
						try {
							const username = await getCurrentUser(pi);
							return fetchPreviousReviews(pi, ref, username);
						} catch {
							/* Previous reviews unavailable — not fatal */
							return { reviews: [], threads: [] };
						}
					},
				},
			] as const,
		);

		if (!results) {
			deactivate(state, pi, ctx);
			return textResult("PR review cancelled.");
		}

		const [graphqlData, diff, siblingPRs, previousData] = results;

		if (!graphqlData || !diff) {
			deactivate(state, pi, ctx);
			return textResult(
				"Failed to gather PR context — metadata or diff unavailable.",
			);
		}

		const context = assembleContext(
			graphqlData.pr,
			diff,
			graphqlData.prComments,
			graphqlData.issues,
			siblingPRs ?? [],
		);

		// Create the review session
		const session = createSession(
			{
				owner: ref.owner,
				repo: ref.repo,
				number: ref.number,
				branch: context.pr.headRefName,
				baseBranch: context.pr.baseRefName,
				author: context.pr.author,
			},
			context,
		);

		// Previous reviews (re-review support)
		if (previousData && previousData.reviews.length > 0) {
			session.previousReview = {
				reviews: previousData.reviews,
				threads: previousData.threads,
			};
		}

		// Set up worktree after we know the PR's head branch
		const onBranch = await isOnPRBranch(pi, context.pr.headRefName);
		if (onBranch) {
			session.worktreePath = null;
			session.usingWorktree = false;
		} else {
			try {
				const path = await createWorktree(pi, ref.number);
				session.worktreePath = path;
				session.usingWorktree = true;
			} catch {
				/* Worktree creation failed — review without it */
				session.worktreePath = null;
				session.usingWorktree = false;
			}
		}

		state.session = session;
		state.phase = "context";

		persist(state, pi);
		refreshUI(state, ctx);

		const fileCount = context.diffFiles.length;
		const issueCount = context.issues.length;
		const siblingCount = context.siblingPRs.length;

		const parts = [
			`PR review activated for ${ref.owner}/${ref.repo}#${ref.number}.`,
			`"${context.pr.title}" by @${context.pr.author}.`,
			`${fileCount} files changed (+${context.pr.additions} -${context.pr.deletions}).`,
			`${issueCount} linked issue${issueCount !== 1 ? "s" : ""}.`,
		];

		if (siblingCount > 0) {
			parts.push(`${siblingCount} sibling PR${siblingCount !== 1 ? "s" : ""}.`);
		}

		if (session.previousReview) {
			const reviewCount = session.previousReview.reviews.length;
			const openThreads = session.previousReview.threads.filter(
				(t) => !t.isResolved,
			).length;
			const resolvedThreads = session.previousReview.threads.filter(
				(t) => t.isResolved,
			).length;
			parts.push(
				`Re-review: ${reviewCount} previous review${reviewCount !== 1 ? "s" : ""}, ` +
					`${openThreads} open thread${openThreads !== 1 ? "s" : ""}, ` +
					`${resolvedThreads} resolved.`,
			);
		}

		if (session.worktreePath) {
			parts.push(`Worktree: ${session.worktreePath}`);
		}

		parts.push(
			"",
			"Call pr_review with action 'context' to show the context summary.",
		);

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "activate", fileCount, issueCount },
		};
	}

	/** Show the gathered context summary panel and return text. */
	async function handleContext(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult(
				"Failed to load PR context. Call 'activate' to restart.",
			);
		}

		const session = state.session;
		const context = session.context;
		if (!context) return textResult("Context unavailable.");

		await showContextSummary(ctx, context, session.worktreePath);

		const parts: string[] = [];

		parts.push(`## PR #${context.pr.number}: ${context.pr.title}`);
		parts.push(`**Author**: @${context.pr.author}`);
		parts.push(
			`**Branch**: ${context.pr.headRefName} → ${context.pr.baseRefName}`,
		);
		parts.push(
			`**Files**: ${context.pr.changedFiles} changed (+${context.pr.additions} -${context.pr.deletions})`,
		);

		if (context.pr.body) {
			parts.push("", "### PR Description", context.pr.body);
		}

		if (context.issues.length > 0) {
			parts.push("", "### Linked Issues");
			for (const issue of context.issues) {
				parts.push(`- **#${issue.number}**: ${issue.title} (${issue.state})`);
				if (issue.body) {
					const preview = issue.body.slice(0, 200);
					const ellipsis = issue.body.length > 200 ? "…" : "";
					parts.push(`  ${preview}${ellipsis}`);
				}
			}
		}

		if (context.siblingPRs.length > 0) {
			parts.push("", "### Related PRs");
			for (const pr of context.siblingPRs) {
				parts.push(`- **#${pr.number}**: ${pr.title} (${pr.state})`);
			}
		}

		parts.push(
			"",
			"Call pr_review with action 'description' to review the PR description and scope.",
		);

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "context", phase: state.phase },
		};
	}

	/** Show description review panel and return evaluation context. */
	async function handleDescription(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult(
				"Failed to load PR context. Call 'activate' to restart.",
			);
		}

		state.phase = "description";
		const context = state.session.context;
		if (!context) return textResult("Context unavailable.");

		await showDescriptionReview(ctx, context);

		const parts: string[] = [];

		parts.push("## PR Description & Scope Review");
		parts.push("");
		parts.push(`**Title**: ${context.pr.title}`);
		parts.push("");

		if (context.pr.body) {
			parts.push("**Description**:");
			parts.push(context.pr.body);
		} else {
			parts.push("**Description**: _(empty)_");
		}

		parts.push("");
		parts.push("### Linked Issues Context");

		if (context.issues.length === 0) {
			parts.push("No linked issues found.");
		} else {
			for (const issue of context.issues) {
				parts.push(`\n#### Issue #${issue.number}: ${issue.title}`);
				if (issue.body) parts.push(issue.body);
			}
		}

		parts.push("");
		parts.push("### Changed Files Summary");
		parts.push(
			`${context.pr.changedFiles} files (+${context.pr.additions} -${context.pr.deletions})`,
		);

		parts.push("");
		parts.push("### Instructions");
		parts.push(
			"Evaluate the PR title, description, and scope against the gathered context.",
		);
		parts.push("Consider:");
		parts.push("- Does the title accurately describe the change?");
		parts.push(
			"- Is the description complete enough to serve as a historic record?",
		);
		parts.push(
			"- Is the scope appropriate? Should this be split into smaller PRs?",
		);
		parts.push("- Does the description match the actual changes in the diff?");
		parts.push("");
		parts.push(
			"Draft any comments about the description using 'add-comment', " +
				"then call 'analyze' for deep analysis.",
		);

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "description", phase: "description" },
		};
	}

	/** Provide rich context for deep analysis. */
	async function handleAnalyze(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult(
				"Failed to load PR context. Call 'activate' to restart.",
			);
		}

		state.phase = "analyzing";

		const session = state.session;
		const context = session.context;
		if (!context) return textResult("Context unavailable.");
		const searchPath = session.worktreePath ?? ".";
		const parts: string[] = [];

		parts.push("## Deep Analysis Context");
		parts.push("");

		if (context.issues.length > 0) {
			parts.push("### Linked Issues");
			for (const issue of context.issues) {
				parts.push(`\n#### Issue #${issue.number}: ${issue.title}`);
				if (issue.body) parts.push(issue.body);
				if (issue.comments.length > 0) {
					parts.push(
						`\n_${issue.comments.length} comment${issue.comments.length !== 1 ? "s" : ""} on this issue._`,
					);
					for (const c of issue.comments.slice(0, 5)) {
						parts.push(`> **@${c.author}**: ${c.body.slice(0, 300)}`);
					}
				}
			}
			parts.push("");
		}

		if (context.prComments.length > 0) {
			parts.push("### PR Discussion");
			for (const c of context.prComments) {
				parts.push(`> **@${c.author}**: ${c.body.slice(0, 300)}`);
			}
			parts.push("");
		}

		parts.push("### Full Diff");
		parts.push("");
		const maxDiffChars = 50000;
		if (context.diff.length <= maxDiffChars) {
			parts.push("```diff");
			parts.push(context.diff);
			parts.push("```");
		} else {
			parts.push(
				`_Diff is ${context.diff.length} characters — showing first ${maxDiffChars} characters. Read individual files for full content._`,
			);
			parts.push("```diff");
			parts.push(context.diff.slice(0, maxDiffChars));
			parts.push("```");
			parts.push("");
			parts.push("**Truncated files** (read from worktree for full diff):");
			for (const file of context.diffFiles) {
				parts.push(`- \`${searchPath}/${file.path}\``);
			}
		}

		if (session.previousReview && session.previousReview.threads.length > 0) {
			parts.push("");
			parts.push("### Previous Review Threads");
			parts.push("");

			const threads = session.previousReview.threads;
			const openThreads = threads.filter((t) => !t.isResolved);
			const resolvedByAuthor = threads.filter((t) => t.resolvedBy === "author");
			const resolvedBySelf = threads.filter((t) => t.resolvedBy === "self");

			if (resolvedBySelf.length > 0) {
				parts.push(
					`**${resolvedBySelf.length} thread${resolvedBySelf.length !== 1 ? "s" : ""} you resolved** — filtered out.`,
				);
			}

			if (resolvedByAuthor.length > 0) {
				parts.push(
					`\n**${resolvedByAuthor.length} thread${resolvedByAuthor.length !== 1 ? "s" : ""} resolved by the author** — assess satisfaction:`,
				);
				for (const t of resolvedByAuthor) {
					parts.push(
						`- ${t.file}:${t.line} — ${t.body.slice(0, 100)}${t.body.length > 100 ? "…" : ""}`,
					);
				}
			}

			if (openThreads.length > 0) {
				parts.push(
					`\n**${openThreads.length} open thread${openThreads.length !== 1 ? "s" : ""}** — check if resolved by new changes:`,
				);
				for (const t of openThreads) {
					parts.push(
						`- ${t.file}:${t.line} — ${t.body.slice(0, 100)}${t.body.length > 100 ? "…" : ""}`,
					);
				}
			}
		}

		parts.push("");
		parts.push("### Investigation Instructions");
		parts.push("");
		parts.push(
			"Perform a thorough analysis. Use `bash` for `rg` searches and " +
				"`read` for file contents. Present findings in conversation.",
		);
		parts.push("");
		parts.push("#### 1. Test Coverage Assessment");
		parts.push("- Are there tests for new behavior?");
		parts.push("- Behavior vs implementation detail testing?");
		parts.push("- Are tests idiomatic for the project's test framework?");
		parts.push(`- Search for test files: \`rg -l 'test|spec' ${searchPath}\``);
		parts.push("");
		parts.push("#### 2. Implementation Analysis");
		parts.push("- Readability — can you understand intent without comments?");
		parts.push("- Abstraction level — consistent within functions?");
		parts.push("- Domain naming — names from the problem domain?");
		parts.push("- Composition — clear separation of concerns?");
		parts.push("");
		parts.push("#### 3. Consistency Check");
		parts.push("- Search for similar patterns in the codebase:");
		for (const file of context.diffFiles.slice(0, 5)) {
			const funcMatch = file.hunks
				.flatMap((h) => h.lines)
				.filter((l) => l.type === "added")
				.map((l) => l.content)
				.find((c) => /(?:function|class|export)\s+\w+/.test(c));
			if (funcMatch) {
				const name = funcMatch.match(/(?:function|class|export)\s+(\w+)/)?.[1];
				if (name) {
					parts.push(`  - \`rg "${name}" ${searchPath}\``);
				}
			}
		}
		parts.push("- Are new patterns consistent with existing code?");
		parts.push("- If a new pattern is introduced, is the old one deprecated?");
		parts.push("");
		parts.push("#### 4. Preliminary Comments");
		parts.push(
			"Draft conventional comments using `add-comment` for anything worth raising.",
		);
		parts.push("Use the `conventional-comments` skill for format guidance.");
		parts.push("");
		parts.push(
			"After analysis, call 'review-files' to start file-by-file review.",
		);

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "analyze", phase: "analyzing" },
		};
	}

	/** Threshold for showing directory grouping in file review. */
	const DIRECTORY_GROUP_THRESHOLD = 15;

	/** Start file-by-file review — show the first file's panel. */
	async function handleReviewFiles(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active. Call 'activate' first.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult(
				"Failed to load PR context. Call 'activate' to restart.",
			);
		}

		state.phase = "files";
		state.fileIndex = 0;

		const context = state.session.context;
		if (!context) return textResult("Context unavailable.");
		const fileCount = context.diffFiles.length;
		if (fileCount >= DIRECTORY_GROUP_THRESHOLD) {
			const dirGroups = groupFilesByDirectory(context.diffFiles);
			const overview = buildDirectoryOverview(dirGroups);
			const fileResult = await showFileAndReturnContext(ctx, 0);
			const content = fileResult.content?.[0];
			const text = content && "text" in content ? content.text : "";
			return {
				...fileResult,
				content: [
					{
						type: "text" as const,
						text: `${overview}\n\n${text}`,
					},
				],
			};
		}

		return showFileAndReturnContext(ctx, 0);
	}

	/** Advance to the next file. */
	async function handleNextFile(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active.");
		}
		if (!(await ensureContext(ctx))) {
			return textResult(
				"Failed to load PR context. Call 'activate' to restart.",
			);
		}

		state.fileIndex++;
		const fileCount = state.session.context?.diffFiles.length ?? 0;

		if (state.fileIndex >= fileCount) {
			return textResult(
				`All ${fileCount} files reviewed. ` +
					`${state.session.comments.length} comments collected. ` +
					"Call 'vet' to enter final vetting.",
			);
		}

		return showFileAndReturnContext(ctx, state.fileIndex);
	}

	/** Show the file review panel, then return text context for the LLM. */
	async function showFileAndReturnContext(
		ctx: ExtensionContext,
		index: number,
	) {
		const session = state.session;
		if (!session?.context) return textResult("No context available.");
		const context = session.context;
		const file = context.diffFiles[index];
		if (!file) return textResult("File index out of range.");

		const fileCount = context.diffFiles.length;

		const panelResult = await showFileReview(
			ctx,
			file,
			index,
			fileCount,
			session.comments,
			session.worktreePath,
		);

		refreshUI(state, ctx);

		if (panelResult.action === "cancel") {
			return textResult(
				"File review paused. Call 'review-files' to resume, " +
					"or 'vet' to proceed to vetting.",
			);
		}

		if (panelResult.action === "steer") {
			const searchPath = session.worktreePath ?? ".";
			return {
				content: [
					{
						type: "text" as const,
						text:
							`User wants to add a comment on ${file.path}:\n\n` +
							`"${panelResult.note}"\n\n` +
							`File context:\n${buildFileTextContext(session, file, index, fileCount)}\n\n` +
							`Worktree path for full file access: \`${searchPath}/${file.path}\`\n\n` +
							"Draft a conventional comment. Choose the appropriate label, " +
							"line range, subject, and discussion. Use the `conventional-comments` " +
							"skill for format guidance. Then call pr_review with action 'add-comment' " +
							"and the structured comment data.\n\n" +
							"After adding the comment, call pr_review with action 'resume' " +
							"to return to file review.",
					},
				],
				details: {
					action: "review-files",
					phase: "files",
					file: file.path,
					steered: true,
				},
			};
		}

		return {
			content: [
				{
					type: "text" as const,
					text: buildFileTextContext(session, file, index, fileCount),
				},
			],
			details: {
				action: "review-files",
				phase: "files",
				file: file.path,
				fileIndex: index,
				fileCount,
			},
		};
	}

	/** Build text context for a file (returned to the LLM). */
	function buildFileTextContext(
		session: ReviewSession,
		file: DiffFile,
		index: number,
		fileCount: number,
	): string {
		const parts: string[] = [];

		parts.push(`## File ${index + 1}/${fileCount}: ${file.path}`);
		parts.push(
			`**Status**: ${file.status} (+${file.additions} -${file.deletions})`,
		);

		parts.push("");
		parts.push("### Diff");
		parts.push("```diff");
		for (const hunk of file.hunks) {
			parts.push(hunk.header);
			for (const line of hunk.lines) {
				const prefix =
					line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
				parts.push(`${prefix}${line.content}`);
			}
		}
		parts.push("```");

		const fileComments = session.comments.filter((c) => c.file === file.path);
		if (fileComments.length > 0) {
			parts.push("");
			parts.push(`### Existing Comments (${fileComments.length})`);
			for (const comment of fileComments) {
				const decorStr =
					comment.decorations.length > 0
						? ` (${comment.decorations.join(", ")})`
						: "";
				parts.push(
					`- **${comment.label}${decorStr}** L${comment.startLine}-${comment.endLine}: ${comment.subject}`,
				);
			}
		}

		if (session.worktreePath) {
			parts.push(
				`\nFull file available at: \`${session.worktreePath}/${file.path}\``,
			);
		}

		parts.push("");
		parts.push(
			"Review this file. Add comments with 'add-comment'. " +
				"Call 'next-file' when done.",
		);

		return parts.join("\n");
	}

	/** Add a structured review comment. */
	function handleAddComment(comment: unknown) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		if (!comment || typeof comment !== "object") {
			return textResult(
				"Provide a comment object with: file, startLine, endLine, " +
					"label, decorations, subject, discussion.",
			);
		}

		const c = comment as Record<string, unknown>;

		const reviewComment = addComment(state.session, {
			file: String(c.file ?? ""),
			startLine: Number(c.startLine ?? 0),
			endLine: Number(c.endLine ?? 0),
			label: String(c.label ?? "suggestion"),
			decorations: Array.isArray(c.decorations)
				? c.decorations.map(String)
				: [],
			subject: String(c.subject ?? ""),
			discussion: String(c.discussion ?? ""),
		});

		persist(state, pi);

		const decorStr =
			reviewComment.decorations.length > 0
				? ` (${reviewComment.decorations.join(", ")})`
				: "";

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Comment added: ${reviewComment.label}${decorStr} on ` +
						`${reviewComment.file}:${reviewComment.startLine}-${reviewComment.endLine}\n` +
						`Subject: ${reviewComment.subject}\n` +
						`Total: ${state.session.comments.length} comments.\n\n` +
						"Call pr_review with action 'resume' to return to file review.",
				},
			],
			details: {
				action: "add-comment",
				commentId: reviewComment.id,
				total: state.session.comments.length,
			},
		};
	}

	/** Return to the current phase after a conversation breakout. */
	async function handleResume(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		if (state.phase === "files" && state.session.context) {
			return showFileAndReturnContext(ctx, state.fileIndex);
		}

		const parts: string[] = [];
		parts.push(`Resuming PR review at phase: ${state.phase}`);
		parts.push(`Comments: ${state.session.comments.length}`);

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "resume", phase: state.phase },
		};
	}

	/** Show final vetting panel — user approves/rejects each comment. */
	async function handleVet(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		state.phase = "vetting";
		const session = state.session;

		if (session.comments.length === 0) {
			return textResult(
				"No comments to vet. Add comments first, or call 'post' " +
					"to submit a review with just a summary body.",
			);
		}

		const hasBlocking = session.comments.some((c) =>
			c.decorations.includes("blocking"),
		);
		const suggestedVerdict = hasBlocking ? "REQUEST_CHANGES" : "COMMENT";

		const draftBody =
			session.body ||
			`Review of ${session.pr.owner}/${session.pr.repo}#${session.pr.number}.`;

		const vettingResult = await showVetting(
			ctx,
			session.comments,
			suggestedVerdict,
			draftBody,
		);

		if (!vettingResult) {
			return textResult(
				"Vetting cancelled. Call 'vet' to retry, or 'post' to submit as-is.",
			);
		}

		if (vettingResult.steerFeedback) {
			const editComment = vettingResult.steerCommentId
				? session.comments.find((c) => c.id === vettingResult.steerCommentId)
				: null;

			const commentContext = editComment
				? `Comment being edited:\n` +
					`- File: ${editComment.file}:${editComment.startLine}-${editComment.endLine}\n` +
					`- Label: ${editComment.label}\n` +
					`- Subject: ${editComment.subject}\n` +
					`- Discussion: ${editComment.discussion}\n`
				: "No specific comment targeted.";

			return {
				content: [
					{
						type: "text" as const,
						text:
							`User feedback during vetting:\n\n"${vettingResult.steerFeedback}"\n\n` +
							`${commentContext}\n` +
							"If the user wants to edit the comment, call 'add-comment' with the updated " +
							"version (same file and line range, updated subject/discussion). " +
							"Then call 'vet' again to re-show the vetting panel.",
					},
				],
				details: { action: "vet", steered: true },
			};
		}

		// Apply decisions to comment statuses
		for (const [commentId, decision] of vettingResult.decisions) {
			const comment = session.comments.find((c) => c.id === commentId);
			if (comment) {
				comment.status = decision;
			}
		}
		session.verdict = vettingResult.verdict;
		session.body = vettingResult.reviewBody;
		persist(state, pi);

		const accepted = commentsByStatus(session, "accepted").length;
		const rejected = commentsByStatus(session, "rejected").length;

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Vetting complete. ${accepted} accepted, ${rejected} rejected. ` +
						`Verdict: ${session.verdict}. Call 'post' to submit the review.`,
				},
			],
			details: {
				action: "vet",
				phase: "vetting",
				accepted,
				rejected,
				verdict: session.verdict,
			},
		};
	}

	/** Post the review to GitHub. */
	async function handlePost() {
		if (!state.session) {
			return textResult("No PR review active.");
		}

		state.phase = "posting";
		const session = state.session;

		const ref: PRReference = {
			owner: session.pr.owner,
			repo: session.pr.repo,
			number: session.pr.number,
		};

		const accepted = commentsByStatus(session, "accepted");

		const ghComments = accepted.map((c) => {
			const decorStr =
				c.decorations.length > 0 ? ` (${c.decorations.join(", ")})` : "";
			const body = `${c.label}${decorStr}: ${c.subject}\n\n${c.discussion}`;

			const comment: {
				path: string;
				line: number;
				start_line?: number;
				side: string;
				start_side?: string;
				body: string;
			} = {
				path: c.file,
				line: c.endLine,
				side: "RIGHT",
				body,
			};

			if (c.startLine !== c.endLine) {
				comment.start_line = c.startLine;
				comment.start_side = "RIGHT";
			}

			return comment;
		});

		try {
			await postReview(pi, ref, session.body, session.verdict, ghComments);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Review posted on ${ref.owner}/${ref.repo}#${ref.number}. ` +
							`${ghComments.length} comment(s), verdict: ${session.verdict}. ` +
							"Call 'deactivate' to exit.",
					},
				],
				details: {
					action: "posted",
					comments: ghComments.length,
					verdict: session.verdict,
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return textResult(`Failed to post review: ${msg}`);
		}
	}

	/** Deactivate PR review mode and clean up. */
	async function handleDeactivate(ctx: ExtensionContext) {
		if (!state.session) {
			return textResult("PR review is not active.");
		}

		const session = state.session;

		if (session.usingWorktree) {
			try {
				await removeWorktree(pi, session.pr.number);
			} catch {
				/* Worktree cleanup failed — not fatal */
			}
		}

		const commentCount = session.comments.length;
		const prNum = session.pr.number;

		deactivate(state, pi, ctx);

		return {
			content: [
				{
					type: "text" as const,
					text: `PR review for #${prNum} complete. ${commentCount} comments collected.`,
				},
			],
			details: { action: "deactivated" },
		};
	}
}

// ---- Module-level helpers ----

/** Get current repo from git remote. */
async function getCurrentRepo(
	pi: ExtensionAPI,
): Promise<{ owner: string; repo: string } | null> {
	const result = await pi.exec("git", ["config", "--get", "remote.origin.url"]);
	if (result.code !== 0) return null;
	return extractOwnerRepo(result.stdout.trim());
}

/** Build a simple text tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

/** Group diff files by their parent directory. */
function groupFilesByDirectory(files: DiffFile[]): Map<string, DiffFile[]> {
	const groups = new Map<string, DiffFile[]>();
	for (const file of files) {
		const lastSlash = file.path.lastIndexOf("/");
		const dir = lastSlash > 0 ? file.path.slice(0, lastSlash) : ".";
		const existing = groups.get(dir) ?? [];
		existing.push(file);
		groups.set(dir, existing);
	}
	return groups;
}

/** Build a directory overview for large PRs. */
function buildDirectoryOverview(groups: Map<string, DiffFile[]>): string {
	const parts: string[] = [];
	parts.push("### Directory Overview");
	parts.push(
		`This PR has changes across ${groups.size} directories. Files are reviewed in order:`,
	);
	parts.push("");

	for (const [dir, files] of groups) {
		const additions = files.reduce((sum, f) => sum + f.additions, 0);
		const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
		parts.push(
			`- **${dir}/** — ${files.length} file${files.length !== 1 ? "s" : ""} (+${additions} -${deletions})`,
		);
	}

	return parts.join("\n");
}
