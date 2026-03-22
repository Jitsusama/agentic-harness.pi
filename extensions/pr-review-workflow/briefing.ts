/**
 * LLM briefings: pure functions that build markdown text
 * for the agent to reason about.
 *
 * Each function takes review data and returns a string.
 * No side effects, no state mutation, no UI.
 */

import type { PRContext, ReviewSession } from "./state.js";

/** Maximum diff characters before truncation. */
const MAX_DIFF_CHARS = 50000;

/** Maximum issue body preview length. */
const MAX_ISSUE_BODY = 500;

/** Maximum comments to show per issue. */
const MAX_ISSUE_COMMENTS = 5;

/**
 * Build the activation briefing: comprehensive context for
 * the agent to analyze and generate comments.
 */
export function activationBriefing(session: ReviewSession): string {
	const context = session.context;
	if (!context) return "Context unavailable.";

	const parts: string[] = [];

	parts.push(`## PR #${context.pr.number}: ${context.pr.title}`);
	parts.push(`**Author**: @${context.pr.author}`);
	parts.push(
		`**Branch**: ${context.pr.headRefName} → ${context.pr.baseRefName}`,
	);
	parts.push(
		`**Files**: ${context.pr.changedFiles} changed (+${context.pr.additions} -${context.pr.deletions})`,
	);
	if (session.worktreePath) {
		parts.push(`**Worktree**: ${session.repoPath} (PR branch checkout)`);
	} else {
		parts.push(`**Repo**: ${session.repoPath}`);
	}
	parts.push("");

	// Reviewers
	if (context.reviewers.length > 0) {
		parts.push("### Reviewers");
		for (const r of context.reviewers) {
			parts.push(`- @${r.login}: ${r.verdict}`);
		}
		parts.push("");
	}

	// PR description
	if (context.pr.body) {
		parts.push("### PR Description");
		parts.push(context.pr.body);
		parts.push("");
	}

	// Linked issues
	if (context.issues.length > 0) {
		parts.push("### Linked Issues");
		for (const issue of context.issues) {
			parts.push(`\n#### Issue #${issue.number}: ${issue.title}`);
			parts.push(`State: ${issue.state}`);
			if (issue.labels.length > 0) {
				parts.push(`Labels: ${issue.labels.join(", ")}`);
			}
			if (issue.body) {
				const preview = issue.body.slice(0, MAX_ISSUE_BODY);
				const ellipsis = issue.body.length > MAX_ISSUE_BODY ? "…" : "";
				parts.push(preview + ellipsis);
			}
			if (issue.parentIssue) {
				parts.push(
					`Parent: #${issue.parentIssue.number}: ${issue.parentIssue.title}`,
				);
			}
			if (issue.subIssues.length > 0) {
				parts.push("Sub-issues:");
				for (const sub of issue.subIssues) {
					parts.push(`  - #${sub.number}: ${sub.title} (${sub.state})`);
				}
			}
			if (issue.comments.length > 0) {
				const shown = issue.comments.slice(0, MAX_ISSUE_COMMENTS);
				parts.push(`\n_${issue.comments.length} comments:_`);
				for (const c of shown) {
					parts.push(`> @${c.author}: ${c.body.slice(0, 300)}`);
				}
			}
		}
		parts.push("");
	}

	// We include URLs so the agent can match them for summaries.
	if (context.references.length > 0) {
		parts.push("### References");
		parts.push(
			"Provide a `reference_summaries` entry for each with a one-sentence summary.",
		);
		for (const r of context.references) {
			parts.push(`- ${r.title}: ${r.url}`);
		}
		parts.push("");
	}

	if (context.hitDepthLimit) {
		parts.push(
			"⚠️ **Crawl depth limit reached**: some references were not followed.",
		);
		parts.push("");
	}

	// Source files
	if (context.sourceFiles.length > 0) {
		parts.push("### Source Files");
		parts.push(
			"These are files the PR interacts with. Fill in the `role` " +
				"field for each in your `source_roles` parameter.",
		);
		for (const f of context.sourceFiles) {
			parts.push(`- \`${f.path}\``);
		}
		parts.push("");
	}

	// Diff
	appendDiff(parts, context);

	// Instructions
	parts.push("### Instructions");
	parts.push("");
	parts.push(
		"Analyze the PR thoroughly, then call `pr_review` with action `generate-comments` providing:",
	);
	parts.push("");
	parts.push(
		"1. **`synopsis`**: a conversational, approachable summary for a human reviewer. " +
			"Lead with the motivation (what problem or need), then explain the approach. " +
			"Write like you're catching up a teammate: not a commit message or changelog entry. " +
			"Avoid listing every file or change mechanically.",
	);
	parts.push(
		"2. **`scope_analysis`**: markdown assessment of scope quality (focused? too broad? well-organized?)",
	);
	parts.push(
		"3. **`source_roles`**: for each source file, one sentence explaining why it's relevant",
	);
	parts.push(
		"4. **`reference_summaries`**: for each discovered reference, a one-sentence " +
			"plain-language summary of what it is and why it matters to this PR",
	);
	parts.push(
		"5. **`comments`**: structured review comments using comment-format conventions:",
	);
	parts.push("   - Categorize as `file`, `title`, or `scope`");
	parts.push(
		"   - Use appropriate labels: praise, nitpick, suggestion, issue, question, thought, todo, note",
	);
	parts.push("   - Add decorations: blocking, non-blocking, if-minor");
	parts.push(
		"   - `scope` comments: only about scope concerns (focus, organization)",
	);
	parts.push(
		"   - `title` comments: about title accuracy and description completeness",
	);
	parts.push("   - `file` comments: code quality, tests, implementation");
	parts.push(
		"   - Write comments as a human reviewer: never mention tools " +
			"(rg, read, bash) or your investigation process in comment text",
	);
	parts.push("");
	parts.push(
		`Use the \`read\` tool to examine source files at \`${session.repoPath}/\` for deeper analysis.`,
	);
	parts.push(
		`Use \`rg\` in \`bash\` to search for patterns in \`${session.repoPath}/\`.`,
	);

	return parts.join("\n");
}

/** Summary returned after comments are generated. */
export function generateCommentsBriefing(session: ReviewSession): string {
	const fileComments = session.comments.filter((c) => c.category === "file");
	const scopeComments = session.comments.filter((c) => c.category === "scope");
	const titleComments = session.comments.filter((c) => c.category === "title");

	const parts: string[] = [];
	parts.push(`${session.comments.length} comments generated:`);
	parts.push(`- ${fileComments.length} file comments`);
	parts.push(`- ${scopeComments.length} scope comments`);
	parts.push(`- ${titleComments.length} title/description comments`);
	parts.push("");
	parts.push(
		"Call pr_review with action 'overview' to show the overview panel.",
	);

	return parts.join("\n");
}

/** Append the full diff (or truncated) to parts. */
function appendDiff(parts: string[], context: PRContext): void {
	parts.push("### Full Diff");
	parts.push("");

	if (context.diff.length <= MAX_DIFF_CHARS) {
		parts.push("```diff");
		parts.push(context.diff);
		parts.push("```");
	} else {
		parts.push(
			`_Diff is ${context.diff.length} characters: showing first ${MAX_DIFF_CHARS}. ` +
				"Read individual files for full content._",
		);
		parts.push("```diff");
		parts.push(context.diff.slice(0, MAX_DIFF_CHARS));
		parts.push("```");
		parts.push("");
		parts.push("**Truncated files** (read from repo for full diff):");
		for (const file of context.diffFiles) {
			parts.push(`- \`${file.path}\``);
		}
	}
	parts.push("");
}
