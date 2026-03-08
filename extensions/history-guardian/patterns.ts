/**
 * Destructive git command patterns.
 *
 * Order matters: more specific patterns must precede general ones.
 * e.g. --force-with-lease (risky) before --force (irrecoverable).
 */

export type Severity = "irrecoverable" | "risky";

export interface DestructivePattern {
	pattern: RegExp;
	severity: Severity;
	description: string;
}

export const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
	// Risky — recoverable via reflog or other means
	{
		pattern: /\bgit\s+push\b[^|;]*--force-with-lease\b/,
		severity: "risky",
		description: "Force push with lease — safer than --force but still rewrites remote history.",
	},
	{
		pattern: /\bgit\s+stash\s+drop\b/,
		severity: "risky",
		description: "Drops a stash entry. Recoverable via git reflog for ~30 days.",
	},
	{
		pattern: /\bgit\s+rebase\b/,
		severity: "risky",
		description: "Rewrites commit history. Recoverable via git reflog.",
	},

	// Irrecoverable — data loss likely
	{
		pattern: /\bgit\s+reset\s+--hard\b/,
		severity: "irrecoverable",
		description: "Permanently discards all uncommitted changes.",
	},
	{
		pattern: /\bgit\s+clean\s+-[a-z]*f/,
		severity: "irrecoverable",
		description: "Permanently deletes untracked files.",
	},
	{
		pattern: /\bgit\s+push\b[^|;]*(?:--force\b|-f\b)/,
		severity: "irrecoverable",
		description: "Force push overwrites remote history — commits may be permanently lost.",
	},
	{
		pattern: /\bgit\s+branch\s+-D\b/,
		severity: "irrecoverable",
		description: "Force-deletes branch regardless of merge status.",
	},
	{
		pattern: /\bgit\s+checkout\s+--\s+\./,
		severity: "irrecoverable",
		description: "Discards all uncommitted changes to tracked files.",
	},
];
