/**
 * LLM briefings — pure functions that build markdown text
 * for the agent to reason about.
 *
 * Each function takes review data and returns a string.
 * No side effects, no state mutation, no UI.
 */

import type { CrawlResult, ReviewSession } from "./state.js";

/** Maximum diff characters before truncation. */
const MAX_DIFF_CHARS = 50000;

/** Maximum issue body preview length. */
const MAX_ISSUE_BODY = 500;

/** Maximum comments to show per issue. */
const MAX_ISSUE_COMMENTS = 5;

// ---- Activation briefing ----

/**
 * Build the activation briefing — comprehensive context for
 * the agent to analyze and generate comments.
 */
export function briefActivation(session: ReviewSession): string {
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
	parts.push(`**Repo**: ${session.repoPath}`);
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
					`Parent: #${issue.parentIssue.number} — ${issue.parentIssue.title}`,
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

	// Reference summary
	if (context.references.length > 0) {
		parts.push("### References");
		const byType = groupBy(context.references, (r) => r.type);
		for (const [type, refs] of Object.entries(byType)) {
			parts.push(`**${type}**: ${refs.length} discovered`);
			for (const r of refs.slice(0, 5)) {
				parts.push(`  - ${r.title} (depth ${r.depth}, from ${r.source})`);
			}
			if (refs.length > 5) {
				parts.push(`  - … and ${refs.length - 5} more`);
			}
		}
		parts.push("");
	}

	if (context.hitDepthLimit) {
		parts.push(
			"⚠️ **Crawl depth limit reached** — some references were not followed.",
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
		"1. **`synopsis`** — 1-2 paragraph summary of what the PR does and why",
	);
	parts.push(
		"2. **`scope_analysis`** — markdown assessment of scope quality (focused? too broad? well-organized?)",
	);
	parts.push(
		"3. **`source_roles`** — for each source file, one sentence explaining why it's relevant",
	);
	parts.push(
		"4. **`comments`** — structured review comments using conventional-comments format:",
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
	parts.push("");
	parts.push(
		"Use the `read` tool to examine source files for deeper analysis.",
	);
	parts.push("Use `rg` in `bash` to search for patterns in the repo.");

	return parts.join("\n");
}

// ---- Generate-comments summary ----

/** Summary returned after comments are generated. */
export function briefGenerateComments(session: ReviewSession): string {
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

// ---- Helpers ----

/** Append the full diff (or truncated) to parts. */
function appendDiff(parts: string[], context: CrawlResult): void {
	parts.push("### Full Diff");
	parts.push("");

	if (context.diff.length <= MAX_DIFF_CHARS) {
		parts.push("```diff");
		parts.push(context.diff);
		parts.push("```");
	} else {
		parts.push(
			`_Diff is ${context.diff.length} characters — showing first ${MAX_DIFF_CHARS}. ` +
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

/** Group items by a key function. */
function groupBy<T>(
	items: T[],
	keyFn: (item: T) => string,
): Record<string, T[]> {
	const groups: Record<string, T[]> = {};
	for (const item of items) {
		const key = keyFn(item);
		if (!groups[key]) groups[key] = [];
		groups[key].push(item);
	}
	return groups;
}
