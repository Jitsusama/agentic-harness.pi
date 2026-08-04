/**
 * Advisory classification of a bash command for the quest phase
 * gate. The command is reduced to its executable skeleton first
 * (heredoc bodies and quoted data removed) so a mutating verb that
 * appears only as a literal argument, or inside a heredoc body,
 * does not trip the gate. This is a nudge toward the right stage,
 * not a security boundary.
 */

import { stripHeredocBodies, stripShellData } from "../../shell/index.js";

/** What kind of write, if any, a bash command performs. */
export type BashWriteKind = "git-mutating" | "bash-write" | "read-only";

/** Git subcommands that change repository or working-tree state. */
const GIT_MUTATING =
	/\bgit(?:\s+(?:-c\s+\S+|-C\s+\S+|--git-dir=\S+|--work-tree=\S+|--no-pager))*\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|switch|restore|am|format-patch)\b/i;

/** Shell patterns that write to the filesystem via redirection or in-place edit. */
const BASH_WRITE_PATTERNS = [
	/(^|\s|[;&|`])cat\s+[^|]*>>?\s/, // cat > foo, cat >> foo
	/(^|\s|[;&|`])tee\s+(?:-[a-z]+\s+)*\S/, // tee foo, tee -a foo
	/(^|\s|[;&|`])sed\s+(?:-[a-z]+\s+)*-i\b/, // sed -i
	/(^|\s|[;&|`])gsed\s+(?:-[a-z]+\s+)*-i\b/, // homebrew sed
	/(^|\s|[;&|`])perl\s+(?:-[a-z]+\s+)*-i\b/, // perl -i
	/(^|\s|[;&|`])printf\s+.+>>?\s/, // printf > foo
	/(^|\s|[;&|`])echo\s+.+>>?\s/, // echo > foo
];

/**
 * Extract the destination paths a bash command writes to, so the
 * gate can see where the write lands and allow scratch
 * destinations. The command is reduced to the same data-stripped
 * skeleton the classifier matches on, so a redirect that lived
 * inside quoted data raises no phantom target. Three write shapes
 * are read: redirect destinations (`>`, `>>`, excluding fd
 * redirects such as `2>`), `tee` destinations, and the file
 * argument of an in-place editor (sed -i, gsed -i, perl -i), whose
 * quoted script has already been stripped, leaving the file as a
 * trailing non-flag token.
 *
 * A target the command builds out of its own variables is expanded
 * from the assignments in that same command, since `Q=...; echo >
 * "$Q/f"` is one of the commonest ways to write to a directory whose
 * path is long. A target still carrying a sigil after that is dropped
 * rather than reported: the caller resolves what it is given against a
 * working directory, so a literal `$UNKNOWN/f.txt` becomes a real path
 * nobody wrote to, and judging the wrong file is worse than declining
 * to judge this one.
 */
export function bashWriteTargets(command: string): string[] {
	const skeleton = stripShellData(stripHeredocBodies(command));
	const assigned = assignmentsIn(skeleton);
	const targets: string[] = [];
	const add = (token: string | undefined): void => {
		if (!token) return;
		const bare = token.replace(/^['"]/, "").replace(/['"]$/, "");
		if (!bare) return;
		const value = expand(bare, assigned);
		// Anything still holding a `$` was built from something this command
		// does not say, so there is nothing honest to report.
		if (value === undefined) return;
		targets.push(value);
	};

	// Redirect destinations: the token following > or >>. A leading
	// digit or & marks an fd redirect (2>, &>), which routes a stream
	// rather than naming a content target, so it is skipped.
	for (const match of skeleton.matchAll(/(?<![0-9&])>>?\s*([^\s;&|<>]+)/g)) {
		add(match[1]);
	}

	// tee destinations: non-flag tokens following a tee invocation.
	for (const match of skeleton.matchAll(
		/(?:^|[|;&]|\s)tee\s+((?:-[^\s]+\s+)*)(\S+)/g,
	)) {
		add(match[2]);
	}

	// In-place editor file arguments: every non-flag token after the
	// editor invocation. An unquoted script token cannot resolve to
	// a tracked path, so it is harmless to include.
	for (const match of skeleton.matchAll(
		/(?:^|[|;&]|\s)(?:g?sed|perl)\s+([^|;&\n]*)/g,
	)) {
		const tokens = (match[1] ?? "").split(/\s+/).filter(Boolean);
		if (!tokens.some((t) => t === "-i" || t.startsWith("-i"))) continue;
		for (const token of tokens) {
			if (token.startsWith("-")) continue;
			add(token);
		}
	}

	return targets;
}

/**
 * The variables a command assigns to itself, last assignment winning.
 *
 * Only the literal `NAME=value` form, which is what a command writing to
 * a long path actually uses. A value built from an earlier variable is
 * expanded against what is known so far, so `A=/tmp; B=$A/x` resolves.
 */
function assignmentsIn(skeleton: string): Map<string, string> {
	const known = new Map<string, string>();
	for (const match of skeleton.matchAll(
		/(?:^|[;&|]|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|<>]*)/g,
	)) {
		const name = match[1];
		if (!name) continue;
		const raw = (match[2] ?? "").replace(/^['"]/, "").replace(/['"]$/, "");
		const value = expand(raw, known);
		if (value !== undefined) known.set(name, value);
	}
	return known;
}

/**
 * A token with its variables filled in, or undefined when one of them is
 * not something this command said.
 *
 * Both spellings, `$NAME` and `${NAME}`. A command substitution is never
 * expanded: what it produces is not knowable from the text.
 */
function expand(token: string, known: Map<string, string>): string | undefined {
	if (!token.includes("$")) return token;
	if (token.includes("$(")) return undefined;
	const filled = token.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(whole, braced, bare) => known.get(braced ?? bare) ?? whole,
	);
	return filled.includes("$") ? undefined : filled;
}

/**
 * Classify a bash command after stripping non-executable content,
 * so quoted literals and heredoc bodies cannot raise a false
 * positive.
 */
export function classifyBashWrite(command: string): BashWriteKind {
	const skeleton = stripShellData(stripHeredocBodies(command));
	if (GIT_MUTATING.test(skeleton)) return "git-mutating";
	if (BASH_WRITE_PATTERNS.some((rx) => rx.test(skeleton))) return "bash-write";
	return "read-only";
}
