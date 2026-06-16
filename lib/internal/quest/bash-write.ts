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
 */
export function bashWriteTargets(command: string): string[] {
	const skeleton = stripShellData(stripHeredocBodies(command));
	const targets: string[] = [];
	const add = (token: string | undefined): void => {
		if (!token) return;
		const value = token.replace(/^['"]/, "").replace(/['"]$/, "");
		if (value) targets.push(value);
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
