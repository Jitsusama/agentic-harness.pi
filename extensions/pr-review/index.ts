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
 *   add-comment  — add a user-requested comment
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
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	assembleContext,
	fetchDiff,
	fetchPRGraphQL,
	fetchSiblingPRs,
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
import type { DiffFile, LinkedIssue, ReviewVerdict } from "./state.js";
import { createPRReviewState, nextCommentId } from "./state.js";
import { buildPRReviewContext, prReviewContextFilter } from "./transitions.js";
import { showContextSummary } from "./ui/context-summary.js";
import { showDescriptionReview } from "./ui/description.js";
import { showFileReview } from "./ui/file-review.js";
import { showProgress } from "./ui/progress.js";
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
	const state = createPRReviewState();

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
						discussion: Type.String({ description: "Comment discussion body" }),
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
					return handleAnalyze();
				case "review-files":
					return handleReviewFiles(ctx);
				case "next-file":
					return handleNextFile(ctx);
				case "add-comment":
					return handleAddComment(params.comment);
				case "resume":
					return handleResume();
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

	// ---- Context injection ----

	pi.on("before_agent_start", async () => {
		return buildPRReviewContext(state);
	});

	pi.on("context", prReviewContextFilter(state));

	// ---- Session restore ----

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
	});

	// ---- Action handlers ----

	/** Activate PR review — gather context with live progress. */
	async function handleActivate(ctx: ExtensionContext, prInput: string | null) {
		if (state.enabled) {
			return textResult(
				`PR review is already active for #${state.prNumber}. ` +
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

		state.owner = ref.owner;
		state.repo = ref.repo;
		state.prNumber = ref.number;
		state.phase = "gathering";

		activate(state, pi, ctx);

		// Shared state for tasks that depend on each other.
		// The sibling PRs task waits for the GraphQL task to
		// populate fetchedIssues before searching.
		let fetchedIssues: LinkedIssue[] = [];
		let graphqlDone: () => void;
		const graphqlReady = new Promise<void>((resolve) => {
			graphqlDone = resolve;
		});

		const results = await showProgress(
			ctx,
			`Gathering context for PR #${ref.number}…`,
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
			] as const,
		);

		if (!results) {
			deactivate(state, pi, ctx);
			return textResult("PR review cancelled.");
		}

		const [graphqlData, diff, siblingPRs] = results;

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

		state.context = context;
		state.prBranch = context.pr.headRefName;
		state.baseBranch = context.pr.baseRefName;
		state.prAuthor = context.pr.author;

		// Set up worktree after we know the PR's head branch
		const onBranch = await isOnPRBranch(pi, context.pr.headRefName);
		if (onBranch) {
			state.worktreePath = null;
			state.usingWorktree = false;
		} else {
			try {
				const path = await createWorktree(pi, ref.number);
				state.worktreePath = path;
				state.usingWorktree = true;
			} catch {
				/* Worktree creation failed — review without it */
				state.worktreePath = null;
				state.usingWorktree = false;
			}
		}

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

		if (state.worktreePath) {
			parts.push(`Worktree: ${state.worktreePath}`);
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
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		const proceeded = await showContextSummary(
			ctx,
			state.context,
			state.worktreePath,
		);

		if (!proceeded) {
			return textResult(
				"Context summary dismissed. Call 'context' to re-show, " +
					"or 'description' to proceed.",
			);
		}

		// Also return the context as text for the LLM
		const prCtx = state.context;
		const parts: string[] = [];

		parts.push(`## PR #${prCtx.pr.number}: ${prCtx.pr.title}`);
		parts.push(`**Author**: @${prCtx.pr.author}`);
		parts.push(`**Branch**: ${prCtx.pr.headRefName} → ${prCtx.pr.baseRefName}`);
		parts.push(
			`**Files**: ${prCtx.pr.changedFiles} changed (+${prCtx.pr.additions} -${prCtx.pr.deletions})`,
		);

		if (prCtx.pr.body) {
			parts.push("", "### PR Description", prCtx.pr.body);
		}

		if (prCtx.issues.length > 0) {
			parts.push("", "### Linked Issues");
			for (const issue of prCtx.issues) {
				parts.push(`- **#${issue.number}**: ${issue.title} (${issue.state})`);
				if (issue.body) {
					const preview = issue.body.slice(0, 200);
					const ellipsis = issue.body.length > 200 ? "…" : "";
					parts.push(`  ${preview}${ellipsis}`);
				}
			}
		}

		if (prCtx.siblingPRs.length > 0) {
			parts.push("", "### Related PRs");
			for (const pr of prCtx.siblingPRs) {
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
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		state.phase = "description";

		await showDescriptionReview(ctx, state.context);

		// Return the full description context for the LLM to evaluate
		const prCtx = state.context;
		const parts: string[] = [];

		parts.push("## PR Description & Scope Review");
		parts.push("");
		parts.push(`**Title**: ${prCtx.pr.title}`);
		parts.push("");

		if (prCtx.pr.body) {
			parts.push("**Description**:");
			parts.push(prCtx.pr.body);
		} else {
			parts.push("**Description**: _(empty)_");
		}

		parts.push("");
		parts.push("### Linked Issues Context");

		if (prCtx.issues.length === 0) {
			parts.push("No linked issues found.");
		} else {
			for (const issue of prCtx.issues) {
				parts.push(`\n#### Issue #${issue.number}: ${issue.title}`);
				if (issue.body) parts.push(issue.body);
			}
		}

		parts.push("");
		parts.push("### Changed Files Summary");
		parts.push(
			`${prCtx.pr.changedFiles} files (+${prCtx.pr.additions} -${prCtx.pr.deletions})`,
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

	/**
	 * Provide rich context for deep analysis — the LLM does the
	 * actual work using bash/read tools. This action returns
	 * everything needed: diff, issue context, PR comments, and
	 * instructions for thorough investigation.
	 */
	function handleAnalyze() {
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		state.phase = "analyzing";

		const prCtx = state.context;
		const searchPath = state.worktreePath ?? ".";
		const parts: string[] = [];

		parts.push("## Deep Analysis Context");
		parts.push("");

		// ---- Issue context (the "why") ----
		if (prCtx.issues.length > 0) {
			parts.push("### Linked Issues");
			for (const issue of prCtx.issues) {
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

		// ---- PR comments (non-review discussion) ----
		if (prCtx.prComments.length > 0) {
			parts.push("### PR Discussion");
			for (const c of prCtx.prComments) {
				parts.push(`> **@${c.author}**: ${c.body.slice(0, 300)}`);
			}
			parts.push("");
		}

		// ---- Full diff ----
		parts.push("### Full Diff");
		parts.push("");
		// Include the raw diff — the LLM needs it for analysis.
		// Cap at a reasonable size to avoid context overflow.
		const maxDiffChars = 50000;
		if (prCtx.diff.length <= maxDiffChars) {
			parts.push("```diff");
			parts.push(prCtx.diff);
			parts.push("```");
		} else {
			parts.push(
				`_Diff is ${prCtx.diff.length} characters — showing first ${maxDiffChars} characters. Read individual files for full content._`,
			);
			parts.push("```diff");
			parts.push(prCtx.diff.slice(0, maxDiffChars));
			parts.push("```");
			parts.push("");
			parts.push("**Truncated files** (read from worktree for full diff):");
			for (const file of prCtx.diffFiles) {
				parts.push(`- \`${searchPath}/${file.path}\``);
			}
		}

		// ---- Investigation instructions ----
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
		for (const file of prCtx.diffFiles.slice(0, 5)) {
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

	/** Start file-by-file review — show the first file's panel. */
	async function handleReviewFiles(ctx: ExtensionContext) {
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		state.phase = "files";
		state.fileIndex = 0;

		return showFileAndReturnContext(ctx, 0);
	}

	/** Advance to the next file. */
	async function handleNextFile(ctx: ExtensionContext) {
		if (!state.enabled || !state.context) {
			return textResult("No PR review active.");
		}

		state.fileIndex++;
		const fileCount = state.context.diffFiles.length;

		if (state.fileIndex >= fileCount) {
			return textResult(
				`All ${fileCount} files reviewed. ` +
					`${state.comments.length} comments collected. ` +
					"Call 'vet' to enter final vetting.",
			);
		}

		return showFileAndReturnContext(ctx, state.fileIndex);
	}

	/**
	 * Show the file review panel, then return text context for
	 * the LLM. If the user steers, return their feedback instead.
	 */
	async function showFileAndReturnContext(
		ctx: ExtensionContext,
		index: number,
	) {
		const prCtx = state.context;
		if (!prCtx) return textResult("No context available.");

		const file = prCtx.diffFiles[index];
		if (!file) return textResult("File index out of range.");

		const fileCount = prCtx.diffFiles.length;

		// Show the visual panel
		const panelResult = await showFileReview(
			ctx,
			file,
			index,
			fileCount,
			state.comments,
			state.worktreePath,
		);

		refreshUI(state, ctx);

		if (panelResult.action === "cancel") {
			return textResult(
				"File review paused. Call 'review-files' to resume, " +
					"or 'vet' to proceed to vetting.",
			);
		}

		if (panelResult.action === "steer") {
			return {
				content: [
					{
						type: "text" as const,
						text:
							`User feedback on ${file.path}:\n\n${panelResult.note}\n\n` +
							buildFileTextContext(file, index, fileCount),
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

		// User pressed "next" — return text context for this file
		return {
			content: [
				{
					type: "text" as const,
					text: buildFileTextContext(file, index, fileCount),
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

		const fileComments = state.comments.filter((c) => c.file === file.path);
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

		if (state.worktreePath) {
			parts.push(
				`\nFull file available at: \`${state.worktreePath}/${file.path}\``,
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
		if (!state.enabled) {
			return textResult("No PR review active.");
		}

		if (!comment || typeof comment !== "object") {
			return textResult(
				"Provide a comment object with: file, startLine, endLine, " +
					"label, decorations, subject, discussion.",
			);
		}

		const c = comment as Record<string, unknown>;
		const id = nextCommentId();

		const reviewComment = {
			id,
			file: String(c.file ?? ""),
			startLine: Number(c.startLine ?? 0),
			endLine: Number(c.endLine ?? 0),
			label: String(c.label ?? "suggestion"),
			decorations: Array.isArray(c.decorations)
				? c.decorations.map(String)
				: [],
			subject: String(c.subject ?? ""),
			discussion: String(c.discussion ?? ""),
			source: "llm" as const,
		};

		state.comments.push(reviewComment);
		state.commentStates.set(id, "draft");

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Comment added: ${reviewComment.label} on ${reviewComment.file}:` +
						`${reviewComment.startLine}-${reviewComment.endLine}. ` +
						`Total: ${state.comments.length} comments.`,
				},
			],
			details: {
				action: "add-comment",
				commentId: id,
				total: state.comments.length,
			},
		};
	}

	/** Return to the current phase after a conversation breakout. */
	function handleResume() {
		if (!state.enabled) {
			return textResult("No PR review active.");
		}

		const parts: string[] = [];
		parts.push(`Resuming PR review at phase: ${state.phase}`);
		parts.push(`Comments: ${state.comments.length}`);

		if (state.phase === "files" && state.context) {
			const file = state.context.diffFiles[state.fileIndex];
			if (file) {
				parts.push(
					`Current file: ${file.path} (${state.fileIndex + 1}/${state.context.diffFiles.length})`,
				);
			}
		}

		if (state.researchNotes.length > 0) {
			parts.push("");
			parts.push("### Research Notes");
			for (const note of state.researchNotes) {
				parts.push(`- ${note}`);
			}
		}

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "resume", phase: state.phase },
		};
	}

	/** Show final vetting panel — user approves/rejects each comment. */
	async function handleVet(ctx: ExtensionContext) {
		if (!state.enabled) {
			return textResult("No PR review active.");
		}

		state.phase = "vetting";

		if (state.comments.length === 0) {
			return textResult(
				"No comments to vet. Add comments first, or call 'post' " +
					"to submit a review with just a summary body.",
			);
		}

		// Determine suggested verdict
		const hasBlocking = state.comments.some((c) =>
			c.decorations.includes("blocking"),
		);
		const suggestedVerdict = hasBlocking ? "REQUEST_CHANGES" : "COMMENT";

		// Draft review body
		const draftBody =
			state.reviewBody ??
			`Review of ${state.owner}/${state.repo}#${state.prNumber}.`;

		const vettingResult = await showVetting(
			ctx,
			state.comments,
			state.commentStates,
			suggestedVerdict as ReviewVerdict,
			draftBody,
		);

		if (!vettingResult) {
			return textResult(
				"Vetting cancelled. Call 'vet' to retry, or 'post' to submit as-is.",
			);
		}

		// Apply decisions
		state.commentStates = vettingResult.decisions;
		state.verdict = vettingResult.verdict;
		state.reviewBody = vettingResult.reviewBody;
		persist(state, pi);

		const accepted = [...vettingResult.decisions.values()].filter(
			(s) => s === "accepted",
		).length;
		const rejected = [...vettingResult.decisions.values()].filter(
			(s) => s === "rejected",
		).length;

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Vetting complete. ${accepted} accepted, ${rejected} rejected. ` +
						`Verdict: ${state.verdict}. Call 'post' to submit the review.`,
				},
			],
			details: {
				action: "vet",
				phase: "vetting",
				accepted,
				rejected,
				verdict: state.verdict,
			},
		};
	}

	/** Post the review to GitHub. */
	async function handlePost() {
		if (!state.enabled || !state.owner || !state.repo || !state.prNumber) {
			return textResult("No PR review active.");
		}

		state.phase = "posting";

		const ref: PRReference = {
			owner: state.owner,
			repo: state.repo,
			number: state.prNumber,
		};

		// Build comments in GitHub's expected format
		const accepted = state.comments.filter(
			(c) => state.commentStates.get(c.id) !== "rejected",
		);

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

		const body = state.reviewBody ?? "";

		try {
			await postReview(pi, ref, body, state.verdict, ghComments);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Review posted on ${ref.owner}/${ref.repo}#${ref.number}. ` +
							`${ghComments.length} comment(s), verdict: ${state.verdict}. ` +
							"Call 'deactivate' to exit.",
					},
				],
				details: {
					action: "posted",
					comments: ghComments.length,
					verdict: state.verdict,
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return textResult(`Failed to post review: ${msg}`);
		}
	}

	/** Deactivate PR review mode and clean up. */
	async function handleDeactivate(ctx: ExtensionContext) {
		if (!state.enabled) {
			return textResult("PR review is not active.");
		}

		// Clean up worktree if we created one
		if (state.usingWorktree && state.prNumber) {
			try {
				await removeWorktree(pi, state.prNumber);
			} catch {
				/* Worktree cleanup failed — not fatal */
			}
		}

		const commentCount = state.comments.length;
		const prNum = state.prNumber;

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

	// ---- Helpers ----

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
}

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
