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
import { fetchPRContext, postReview } from "./api/github.js";
import type { PRReference } from "./api/parse.js";
import { extractOwnerRepo, parsePRReference } from "./api/parse.js";
import {
	activate,
	deactivate,
	persist,
	refreshUI,
	restore,
} from "./lifecycle.js";
import { createPRReviewState, nextCommentId } from "./state.js";
import { buildPRReviewContext, prReviewContextFilter } from "./transitions.js";
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
					return handleContext();
				case "description":
					return handleDescription();
				case "analyze":
					return handleAnalyze();
				case "review-files":
					return handleReviewFiles();
				case "next-file":
					return handleNextFile();
				case "add-comment":
					return handleAddComment(params.comment);
				case "resume":
					return handleResume();
				case "vet":
					return handleVet();
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

	/** Activate PR review — gather context and prepare workspace. */
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
		ctx.ui.notify("Gathering PR context…", "info");

		try {
			const context = await fetchPRContext(pi, ref);
			state.context = context;
			state.prBranch = context.pr.headRefName;
			state.baseBranch = context.pr.baseRefName;
			state.prAuthor = context.pr.author;

			// Set up worktree if not on the PR branch
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
				parts.push(
					`${siblingCount} sibling PR${siblingCount !== 1 ? "s" : ""}.`,
				);
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
				details: {
					action: "activate",
					fileCount,
					issueCount,
				},
			};
		} catch (err) {
			deactivate(state, pi, ctx);
			const msg = err instanceof Error ? err.message : String(err);
			return textResult(`Failed to gather PR context: ${msg}`);
		}
	}

	/** Show the gathered context summary. */
	function handleContext() {
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		const ctx = state.context;
		const parts: string[] = [];

		parts.push(`## PR #${ctx.pr.number}: ${ctx.pr.title}`);
		parts.push(`**Author**: @${ctx.pr.author}`);
		parts.push(`**Branch**: ${ctx.pr.headRefName} → ${ctx.pr.baseRefName}`);
		parts.push(
			`**Files**: ${ctx.pr.changedFiles} changed (+${ctx.pr.additions} -${ctx.pr.deletions})`,
		);

		if (ctx.pr.body) {
			parts.push("", "### PR Description", ctx.pr.body);
		}

		if (ctx.issues.length > 0) {
			parts.push("", "### Linked Issues");
			for (const issue of ctx.issues) {
				parts.push(`- **#${issue.number}**: ${issue.title} (${issue.state})`);
				if (issue.body) {
					const preview = issue.body.slice(0, 200);
					const ellipsis = issue.body.length > 200 ? "…" : "";
					parts.push(`  ${preview}${ellipsis}`);
				}
			}
		}

		if (ctx.siblingPRs.length > 0) {
			parts.push("", "### Related PRs");
			for (const pr of ctx.siblingPRs) {
				parts.push(`- **#${pr.number}**: ${pr.title} (${pr.state})`);
			}
		}

		if (ctx.diffFiles.length > 0) {
			parts.push("", "### Changed Files");
			for (const file of ctx.diffFiles) {
				parts.push(
					`- ${file.path} (${file.status}, +${file.additions} -${file.deletions})`,
				);
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

	/** Return PR description and scope for evaluation. */
	function handleDescription() {
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		state.phase = "description";

		const ctx = state.context;
		const parts: string[] = [];

		parts.push("## PR Description & Scope Review");
		parts.push("");
		parts.push(`**Title**: ${ctx.pr.title}`);
		parts.push("");

		if (ctx.pr.body) {
			parts.push("**Description**:");
			parts.push(ctx.pr.body);
		} else {
			parts.push("**Description**: _(empty)_");
		}

		parts.push("");
		parts.push("### Linked Issues Context");

		if (ctx.issues.length === 0) {
			parts.push("No linked issues found.");
		} else {
			for (const issue of ctx.issues) {
				parts.push(`\n#### Issue #${issue.number}: ${issue.title}`);
				if (issue.body) parts.push(issue.body);
			}
		}

		parts.push("");
		parts.push("### Changed Files Summary");
		parts.push(
			`${ctx.pr.changedFiles} files (+${ctx.pr.additions} -${ctx.pr.deletions})`,
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

	/** Provide context for deep analysis — LLM does the actual work. */
	function handleAnalyze() {
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		state.phase = "analyzing";

		const ctx = state.context;
		const parts: string[] = [];

		parts.push("## Deep Analysis");
		parts.push("");
		parts.push(
			"You now have full access to the PR context. Perform a thorough analysis:",
		);
		parts.push("");
		parts.push("### 1. Test Coverage Assessment");
		parts.push(
			"- Are there tests for new behavior? Are they testing behavior vs implementation details?",
		);
		parts.push("- Are the tests idiomatic for the project's test framework?");
		parts.push("");
		parts.push("### 2. Implementation Analysis");
		parts.push("- Readability, abstraction level, domain naming, composition");
		parts.push("");
		parts.push("### 3. Consistency Check");
		parts.push(
			"- Search the codebase for similar patterns. Are the new patterns consistent?",
		);

		if (state.worktreePath) {
			parts.push(
				`\nUse the worktree at \`${state.worktreePath}\` for file reads and \`rg\` searches.`,
			);
		} else {
			parts.push(
				"\nUse the current directory for file reads and `rg` searches.",
			);
		}

		parts.push("\n### Diff for Reference");
		// Include a summary rather than the full diff (which could be huge)
		parts.push(`${ctx.diffFiles.length} files changed. Key files:`);
		for (const file of ctx.diffFiles.slice(0, 20)) {
			parts.push(
				`- ${file.path} (${file.status}, +${file.additions} -${file.deletions})`,
			);
		}
		if (ctx.diffFiles.length > 20) {
			parts.push(`- … and ${ctx.diffFiles.length - 20} more files`);
		}

		parts.push("");
		parts.push(
			"After analysis, draft preliminary comments using 'add-comment', " +
				"then call 'review-files' to start file-by-file review.",
		);

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: { action: "analyze", phase: "analyzing" },
		};
	}

	/** Start file-by-file review — return the first file's diff. */
	function handleReviewFiles() {
		if (!state.enabled || !state.context) {
			return textResult("No PR review active. Call 'activate' first.");
		}

		state.phase = "files";
		state.fileIndex = 0;

		return buildFileContext(0);
	}

	/** Advance to the next file. */
	function handleNextFile() {
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

		return buildFileContext(state.fileIndex);
	}

	/** Build context for a specific file in the diff. */
	function buildFileContext(index: number) {
		const ctx = state.context;
		if (!ctx) return textResult("No context available.");

		const file = ctx.diffFiles[index];
		if (!file) return textResult("File index out of range.");

		const fileCount = ctx.diffFiles.length;
		const parts: string[] = [];

		parts.push(`## File ${index + 1}/${fileCount}: ${file.path}`);
		parts.push(
			`**Status**: ${file.status} (+${file.additions} -${file.deletions})`,
		);

		// Include the diff for this file
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

		// Show existing comments for this file
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

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: {
				action: "review-files",
				phase: "files",
				file: file.path,
				fileIndex: index,
				fileCount,
			},
		};
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

	/** Enter final vetting phase — list all comments for review. */
	function handleVet() {
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

		const parts: string[] = [];
		parts.push("## Final Vetting");
		parts.push("");
		parts.push(`${state.comments.length} comment(s) to review:`);
		parts.push("");

		for (let i = 0; i < state.comments.length; i++) {
			const c = state.comments[i];
			if (!c) continue;
			const vetState = state.commentStates.get(c.id) ?? "draft";
			const decorStr =
				c.decorations.length > 0 ? ` (${c.decorations.join(", ")})` : "";

			parts.push(`### ${i + 1}. ${c.label}${decorStr} [${vetState}]`);
			parts.push(`**${c.file}:${c.startLine}-${c.endLine}**`);
			parts.push(`${c.subject}`);
			if (c.discussion) {
				parts.push("");
				parts.push(c.discussion);
			}
			parts.push("");
		}

		// Suggest verdict based on comment labels
		const hasBlocking = state.comments.some((c) =>
			c.decorations.includes("blocking"),
		);
		const suggestedVerdict = hasBlocking ? "REQUEST_CHANGES" : "COMMENT";

		parts.push(`### Suggested Verdict: ${suggestedVerdict}`);
		parts.push("");
		parts.push(
			"Present these comments to the user for vetting. " +
				"Then call 'post' to submit the review.",
		);

		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: {
				action: "vet",
				phase: "vetting",
				count: state.comments.length,
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
