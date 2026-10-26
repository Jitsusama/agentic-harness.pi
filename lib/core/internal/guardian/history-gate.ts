/**
 * Destructive git command detection: the decision core behind
 * history-guardian's confirmation gate.
 *
 * Unlike the content gates (prose, section, title), this has no
 * block-once-relent-on-repeat state machine: a `git reset --hard`
 * is exactly as destructive the fifth time it is attempted as the
 * first, so there is nothing here for a GateDeps signature store to
 * do. Detection runs fresh on every command.
 *
 * Getting a human's actual allow/block/redirect decision needs a
 * host's own confirmation UI (pi's modal, Claude Code's native
 * permission prompt) and stays adapter-local, along with how each
 * host renders the match into what its UI shows. This is only the
 * pure "is this command one of the ones we warn about" question,
 * plus what to do instead: an irrecoverable match carries a remedy
 * a host can hand back, and a rewrite where the safe form means the
 * same thing and needs no judgement.
 */

/** How dangerous a destructive git operation is. */
export type Severity = "irrecoverable" | "risky";

/** A regex pattern that matches a destructive git command. */
export interface DestructivePattern {
	pattern: RegExp;
	severity: Severity;
	description: string;
	/** What to run instead, said to whoever issued the command. */
	remedy?: string;
	/** The safe form, when it is mechanical. */
	rewrite?: (command: string) => string;
}

/**
 * Known destructive git patterns, ordered from most specific to
 * most general so narrower matches win (e.g. --force-with-lease,
 * risky, must precede the general --force pattern, irrecoverable).
 */
export const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
	// Risky: recoverable via reflog or other means
	{
		pattern: /\bgit\s+push\b[^|;]*--force-with-lease\b/,
		severity: "risky",
		description:
			"Force push with lease: safer than --force but still rewrites remote history.",
	},
	{
		pattern: /\bgit\s+stash\s+drop\b/,
		severity: "risky",
		description:
			"Drops a stash entry. Recoverable via git reflog for ~30 days.",
	},
	{
		pattern: /\bgit\s+rebase\b/,
		severity: "risky",
		description: "Rewrites commit history. Recoverable via git reflog.",
	},

	// Irrecoverable: data loss likely
	{
		pattern: /\bgit\s+reset\s+--hard\b/,
		severity: "irrecoverable",
		description: "Permanently discards all uncommitted changes.",
		remedy:
			"Run `git stash push --include-untracked` first so the changes can come back, or use `git reset --keep`, which refuses rather than discarding local changes.",
	},
	{
		pattern: /\bgit\s+clean\s+-[a-z]*f/,
		severity: "irrecoverable",
		description: "Permanently deletes untracked files.",
		remedy:
			"Run `git clean -n` with the same flags to list what would go, then remove only those paths, or `git stash push --include-untracked` to set them aside.",
	},
	{
		pattern: /\bgit\s+push\b[^|;]*(?:--force\b|-f\b)/,
		severity: "irrecoverable",
		description:
			"Force push overwrites remote history: commits may be permanently lost.",
		remedy:
			"Use `--force-with-lease`, which refuses when the remote has moved since you last fetched.",
		rewrite: leasedPush,
	},
	{
		pattern: /\bgit\s+branch\s+-D\b/,
		severity: "irrecoverable",
		description: "Force-deletes branch regardless of merge status.",
		remedy:
			"Use `git branch -d`, which deletes only a merged branch. If it refuses, the branch holds unmerged commits: say so rather than forcing it.",
	},
	{
		pattern: /\bgit\s+checkout\s+--\s+\./,
		severity: "irrecoverable",
		description: "Discards all uncommitted changes to tracked files.",
		remedy:
			"Run `git stash push` first so the changes can come back, or restore only the paths you mean to.",
	},
];

/** The push itself, up to whatever ends its command. */
const PUSH_SEGMENT = /\bgit\s+push\b[^|;&]*/;

/** A bare force flag as its own word, not a lease and not part of a name. */
const BARE_FORCE = /(^|\s)(?:--force|-f)(?=\s|$)/g;

/** A force push with the bare flag swapped for a lease. */
function leasedPush(command: string): string {
	return command.replace(PUSH_SEGMENT, (push) =>
		push.replace(BARE_FORCE, "$1--force-with-lease"),
	);
}

/** A command matched against the destructive patterns. */
export interface DestructiveMatch {
	command: string;
	severity: Severity;
	description: string;
	/** What to run instead. Present on every irrecoverable match. */
	remedy?: string;
	/** The whole command in its safe form, when that is mechanical. */
	rewrite?: string;
}

/**
 * Match a command against the known destructive patterns, returning
 * the first (most specific) match, or null when nothing matches.
 */
export function detectDestructiveCommand(
	command: string,
): DestructiveMatch | null {
	for (const found of DESTRUCTIVE_PATTERNS) {
		if (!found.pattern.test(command)) continue;
		const match: DestructiveMatch = {
			command,
			severity: found.severity,
			description: found.description,
		};
		if (found.remedy) match.remedy = found.remedy;
		if (found.rewrite) match.rewrite = found.rewrite(command);
		return match;
	}
	return null;
}
