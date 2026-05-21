/** Shared operating rules for reviewer subprocess prompts. */

/**
 * Return the generic workspace and tool-use rules all
 * pr-workflow reviewer subprocesses must follow.
 */
export function reviewerOperatingRules(): string {
	return [
		"## Workspace and tool-use rules",
		"You are already running inside the review worktree as your current " +
			"working directory. Treat that directory as the whole workspace for " +
			"this review.",
		"Stay inside the current working directory. Do not search `/`, " +
			"`/Users`, `$HOME`, `~`, `~/src`, parent directories, sibling " +
			"checkouts or unrelated repositories.",
		"Do not run broad filesystem discovery. Avoid `find` unless it is " +
			"bounded to `.` with a narrow predicate and a shallow `-maxdepth`. " +
			"Never run commands like `find /`, `find /Users`, `find ~` or " +
			"`grep -R` over broad roots.",
		"Prefer scoped tools and commands: `read` for known files, `rg` for " +
			"targeted searches under the current directory, `glob` for narrow " +
			"file patterns and `ls` for nearby directory inspection.",
		"If the provided diff and current worktree do not contain enough " +
			"context, say so in your findings or warnings. Do not roam the " +
			"filesystem looking for missing context.",
	].join("\n\n");
}
