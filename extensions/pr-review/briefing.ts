/**
 * LLM briefings — pure functions that build markdown text
 * for the agent to reason about.
 *
 * Each function takes review data and returns a string.
 * No side effects, no state mutation, no UI.
 */

import type {
	DiffFile,
	GatheredContext,
	PreviousReviewData,
	ReviewComment,
	ReviewSession,
} from "./state.js";

/** Maximum diff characters before truncation. */
const MAX_DIFF_CHARS = 50000;

/** Maximum issue comments shown in analysis. */
const MAX_ISSUE_COMMENTS = 5;

/** Maximum comment body preview length. */
const MAX_COMMENT_PREVIEW = 300;

/** Maximum thread body preview length. */
const MAX_THREAD_PREVIEW = 100;

// ---- Activation ----

/** Summary text returned after activation. */
export function briefActivation(session: ReviewSession): string {
	const { pr, context, worktreePath, previousReview } = session;
	if (!context) return "";

	const parts = [
		`PR review activated for ${pr.owner}/${pr.repo}#${pr.number}.`,
		`"${context.pr.title}" by @${context.pr.author}.`,
		`${context.diffFiles.length} files changed (+${context.pr.additions} -${context.pr.deletions}).`,
		`${context.issues.length} linked issue${context.issues.length !== 1 ? "s" : ""}.`,
	];

	if (context.siblingPRs.length > 0) {
		const n = context.siblingPRs.length;
		parts.push(`${n} sibling PR${n !== 1 ? "s" : ""}.`);
	}

	if (previousReview) {
		const n = previousReview.reviews.length;
		const open = previousReview.threads.filter((t) => !t.isResolved).length;
		const resolved = previousReview.threads.filter((t) => t.isResolved).length;
		parts.push(
			`Re-review: ${n} previous review${n !== 1 ? "s" : ""}, ` +
				`${open} open thread${open !== 1 ? "s" : ""}, ` +
				`${resolved} resolved.`,
		);
	}

	if (worktreePath) {
		parts.push(`Worktree: ${worktreePath}`);
	}

	parts.push(
		"",
		"Call pr_review with action 'context' to show the context summary.",
	);

	return parts.join("\n");
}

// ---- Context ----

/** Context summary for the LLM after the user views the panel. */
export function briefContext(context: GatheredContext): string {
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

	return parts.join("\n");
}

// ---- Description ----

/** Description review context with evaluation checklist. */
export function briefDescription(context: GatheredContext): string {
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

	return parts.join("\n");
}

/** Context returned when the user steers during description review. */
export function briefDescriptionSteer(
	context: GatheredContext,
	note: string,
): string {
	return [
		`User feedback on the PR description/scope:`,
		"",
		`"${note}"`,
		"",
		`**Title**: ${context.pr.title}`,
		"",
		context.pr.body
			? `**Description**:\n${context.pr.body}`
			: "**Description**: _(empty)_",
		"",
		`**Scope**: ${context.pr.changedFiles} files (+${context.pr.additions} -${context.pr.deletions})`,
		"",
		"Draft a conventional comment addressing the user's feedback. " +
			"Use 'add-comment' with the appropriate label and details. " +
			"Then call 'description' again to return to the panel, " +
			"or 'analyze' to proceed to deep analysis.",
	].join("\n");
}

// ---- Analysis ----

/** Deep analysis context with diff, issues, and investigation guidance. */
export function briefAnalysis(
	context: GatheredContext,
	searchPath: string,
	previousReview: PreviousReviewData | null,
): string {
	const parts: string[] = [];

	parts.push("## Deep Analysis Context");
	parts.push("");

	appendIssueContext(parts, context);
	appendPRDiscussion(parts, context);
	appendDiff(parts, context, searchPath);
	appendPreviousThreads(parts, previousReview);
	appendInvestigationInstructions(parts, context, searchPath);

	return parts.join("\n");
}

// ---- File review ----

/** Summary after completing the tabbed file review. */
export function briefFileReview(
	files: DiffFile[],
	comments: ReviewComment[],
): string {
	const parts: string[] = [];

	parts.push("## File Review Complete");
	parts.push(`${files.length} files reviewed. ${comments.length} comments.`);
	parts.push("");

	if (comments.length > 0) {
		parts.push("### Comments");
		for (const comment of comments) {
			const decorStr =
				comment.decorations.length > 0
					? ` (${comment.decorations.join(", ")})`
					: "";
			parts.push(
				`- **${comment.label}${decorStr}** ${comment.file}:${comment.startLine}-${comment.endLine}: ${comment.subject}`,
			);
		}
		parts.push("");
	}

	parts.push(
		"Add more comments with 'add-comment', or call 'vet' to enter final vetting.",
	);

	return parts.join("\n");
}

/** Context returned when the user steers on a specific file. */
export function briefFileSteer(
	filePath: string,
	note: string,
	worktreePath: string | null,
): string {
	const searchPath = worktreePath ?? ".";

	return [
		`User wants to add a comment on ${filePath}:`,
		"",
		`"${note}"`,
		"",
		`Full file available at: \`${searchPath}/${filePath}\``,
		"",
		"Draft a conventional comment. Choose the appropriate label, " +
			"line range, subject, and discussion. Use the `conventional-comments` " +
			"skill for format guidance. Then call pr_review with action 'add-comment' " +
			"and the structured comment data.",
		"",
		"After adding the comment, call pr_review with action 'review-files' " +
			"to return to file review.",
	].join("\n");
}

// ---- Analysis sub-sections ----

/** Append linked issue bodies and comments to parts. */
function appendIssueContext(parts: string[], context: GatheredContext): void {
	if (context.issues.length === 0) return;

	parts.push("### Linked Issues");
	for (const issue of context.issues) {
		parts.push(`\n#### Issue #${issue.number}: ${issue.title}`);
		if (issue.body) parts.push(issue.body);
		if (issue.comments.length > 0) {
			const n = issue.comments.length;
			parts.push(`\n_${n} comment${n !== 1 ? "s" : ""} on this issue._`);
			for (const c of issue.comments.slice(0, MAX_ISSUE_COMMENTS)) {
				parts.push(
					`> **@${c.author}**: ${c.body.slice(0, MAX_COMMENT_PREVIEW)}`,
				);
			}
		}
	}
	parts.push("");
}

/** Append PR discussion comments to parts. */
function appendPRDiscussion(parts: string[], context: GatheredContext): void {
	if (context.prComments.length === 0) return;

	parts.push("### PR Discussion");
	for (const c of context.prComments) {
		parts.push(`> **@${c.author}**: ${c.body.slice(0, MAX_COMMENT_PREVIEW)}`);
	}
	parts.push("");
}

/** Append the full diff (or truncated with file list) to parts. */
function appendDiff(
	parts: string[],
	context: GatheredContext,
	searchPath: string,
): void {
	parts.push("### Full Diff");
	parts.push("");

	if (context.diff.length <= MAX_DIFF_CHARS) {
		parts.push("```diff");
		parts.push(context.diff);
		parts.push("```");
	} else {
		parts.push(
			`_Diff is ${context.diff.length} characters — showing first ${MAX_DIFF_CHARS} characters. Read individual files for full content._`,
		);
		parts.push("```diff");
		parts.push(context.diff.slice(0, MAX_DIFF_CHARS));
		parts.push("```");
		parts.push("");
		parts.push("**Truncated files** (read from worktree for full diff):");
		for (const file of context.diffFiles) {
			parts.push(`- \`${searchPath}/${file.path}\``);
		}
	}
}

/** Append previous review thread assessment to parts. */
function appendPreviousThreads(
	parts: string[],
	previousReview: PreviousReviewData | null,
): void {
	if (!previousReview || previousReview.threads.length === 0) return;

	parts.push("");
	parts.push("### Previous Review Threads");
	parts.push("");

	const { threads } = previousReview;
	const open = threads.filter((t) => !t.isResolved);
	const resolvedByAuthor = threads.filter((t) => t.resolvedBy === "author");
	const resolvedBySelf = threads.filter((t) => t.resolvedBy === "self");

	if (resolvedBySelf.length > 0) {
		const n = resolvedBySelf.length;
		parts.push(
			`**${n} thread${n !== 1 ? "s" : ""} you resolved** — filtered out.`,
		);
	}

	if (resolvedByAuthor.length > 0) {
		const n = resolvedByAuthor.length;
		parts.push(
			`\n**${n} thread${n !== 1 ? "s" : ""} resolved by the author** — assess satisfaction:`,
		);
		for (const t of resolvedByAuthor) {
			const preview = t.body.slice(0, MAX_THREAD_PREVIEW);
			const ellipsis = t.body.length > MAX_THREAD_PREVIEW ? "…" : "";
			parts.push(`- ${t.file}:${t.line} — ${preview}${ellipsis}`);
		}
	}

	if (open.length > 0) {
		const n = open.length;
		parts.push(
			`\n**${n} open thread${n !== 1 ? "s" : ""}** — check if resolved by new changes:`,
		);
		for (const t of open) {
			const preview = t.body.slice(0, MAX_THREAD_PREVIEW);
			const ellipsis = t.body.length > MAX_THREAD_PREVIEW ? "…" : "";
			parts.push(`- ${t.file}:${t.line} — ${preview}${ellipsis}`);
		}
	}
}

/** Append investigation instructions with auto-generated rg commands. */
function appendInvestigationInstructions(
	parts: string[],
	context: GatheredContext,
	searchPath: string,
): void {
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
}
