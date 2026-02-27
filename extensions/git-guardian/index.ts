/**
 * Git Guardian Extension
 *
 * Safety net for git operations. The conventional-commits skill
 * teaches the agent to write good messages in heredoc format —
 * this extension just lets you review before anything lands.
 *
 * 1. Commit review — intercepts git commit, shows the message,
 *    and lets you approve, steer, edit, or reject.
 *    Normalizes all commits to heredoc format on execution.
 *
 * 2. Destructive command protection — confirms before dangerous
 *    git operations with the same steer option.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// ---- Destructive command patterns ----
// More specific first — first match wins.

type Severity = "irrecoverable" | "risky";

const DESTRUCTIVE_PATTERNS: {
	pattern: RegExp;
	severity: Severity;
	description: string;
}[] = [
	{
		pattern: /\bgit\s+push\b[^|;]*--force-with-lease\b/,
		severity: "risky",
		description:
			"Force push with lease — safer than --force but still rewrites remote history.",
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
		description:
			"Rewrites commit history. Recoverable via git reflog.",
	},
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
		description:
			"Force push overwrites remote history — commits may be permanently lost.",
	},
	{
		pattern: /\bgit\s+branch\s+-D\b/,
		severity: "irrecoverable",
		description: "Force-deletes branch regardless of merge status.",
	},
	{
		pattern: /\bgit\s+checkout\s+--\s+\./,
		severity: "irrecoverable",
		description:
			"Discards all uncommitted changes to tracked files.",
	},
];

// ---- Message extraction ----
// Heredoc is the expected format (taught by the conventional-commits
// skill). The -m fallback handles the case where the agent doesn't
// follow the skill.

function extractMessage(command: string): string | null {
	// Heredoc: <<'DELIM' or <<DELIM
	const heredoc = command.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2]!;

	// Fallback: -m "..." (normalize -am first)
	const normalized = command.replace(/-am\s+/g, "-a -m ");
	const messages: string[] = [];
	const re = /(?:^|\s)-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
	let match;
	while ((match = re.exec(normalized)) !== null) {
		messages.push(
			(match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1"),
		);
	}
	return messages.length > 0 ? messages.join("\n\n") : null;
}

// ---- Command parsing ----

function splitAtCommit(command: string): {
	prefix: string | null;
	commitPart: string;
} {
	const match = command.match(
		/^(.*?)\s*(?:&&|;)\s*(git\s+commit\b[\s\S]*)$/,
	);
	if (match?.[1]?.trim()) {
		return { prefix: match[1].trim(), commitPart: match[2]! };
	}
	return { prefix: null, commitPart: command };
}

function extractCommitFlags(commitPart: string): string[] {
	const flags: string[] = [];
	if (/--amend\b/.test(commitPart)) flags.push("--amend");
	if (/--no-verify\b/.test(commitPart)) flags.push("--no-verify");
	if (/--allow-empty\b/.test(commitPart)) flags.push("--allow-empty");
	if (/--signoff\b|\s-s\b/.test(commitPart)) flags.push("--signoff");
	if (/-a\b|-am\b/.test(commitPart)) flags.push("-a");
	return flags;
}

// ---- Canonical heredoc commit ----

const HEREDOC_DELIM = "__COMMIT_MSG__";

function buildHeredoc(message: string, flags: string[]): string {
	const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
	return [
		`git commit${flagStr} -F- <<'${HEREDOC_DELIM}'`,
		message,
		HEREDOC_DELIM,
	].join("\n");
}

// ---- Shared steer flow ----
// Both gates use: approve, steer (natural language feedback), reject.
// Commit review adds edit (manual rewrite).

async function steer(
	ctx: ExtensionContext,
	blockedCommand: string,
	context: string,
): Promise<{ block: true; reason: string }> {
	const feedback = await ctx.ui.input("Feedback:");
	if (!feedback?.trim()) {
		return { block: true, reason: `User blocked: ${blockedCommand}` };
	}
	return {
		block: true,
		reason: [
			"User wants a different approach.",
			"",
			`Feedback: ${feedback.trim()}`,
			"",
			context,
			"",
			"Adjust based on the feedback and try again.",
		].join("\n"),
	};
}

// ---- Commit review ----

async function reviewCommit(
	command: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	const message = extractMessage(command);
	if (!message) return; // No message extractable — let through

	const isAmend = /--amend\b/.test(command);
	const { prefix, commitPart } = splitAtCommit(command);
	const flags = extractCommitFlags(commitPart);
	let current = message;

	while (true) {
		const indented = current
			.split("\n")
			.map((l) => `  ${l}`)
			.join("\n");
		const amendNote = isAmend ? "\n⚠ Amends previous commit" : "";

		const title = `Commit Review\n\n${indented}${amendNote}`;

		const choice = await ctx.ui.select(title, [
			"Approve",
			"Steer",
			"Edit",
			"Reject",
		]);

		if (choice === "Approve") {
			if (prefix) {
				const pre = await pi.exec("bash", ["-c", prefix]);
				if (pre.code !== 0) {
					return {
						block: true,
						reason: `Pre-commit command failed:\n${(pre.stdout + pre.stderr).trim()}`,
					};
				}
			}
			const heredoc = buildHeredoc(current, flags);
			const result = await pi.exec("bash", ["-c", heredoc]);
			const output = [result.stdout, result.stderr]
				.filter(Boolean)
				.join("\n")
				.trim();
			if (result.code !== 0) {
				return { block: true, reason: `Commit failed:\n${output}` };
			}
			return {
				block: true,
				reason: output || `Committed:\n\n${current}`,
			};
		}

		if (choice === "Steer") {
			return steer(ctx, command, `Original message:\n${current}`);
		}

		if (choice === "Edit") {
			const edited = await ctx.ui.editor(
				"Edit commit message:",
				current,
			);
			if (edited !== undefined && edited.trim()) {
				current = edited;
			}
			continue;
		}

		return {
			block: true,
			reason: "User rejected the commit. Ask for guidance on the commit message.",
		};
	}
}

// ---- Destructive command confirmation ----

async function confirmDestructive(
	command: string,
	severity: Severity,
	description: string,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	const icon = severity === "irrecoverable" ? "⛔" : "⚠";
	const label =
		severity === "irrecoverable"
			? "Destructive Command"
			: "Risky Command";

	const title = `${icon} ${label}\n\n  ${command}\n\n${description}`;

	const choice = await ctx.ui.select(title, [
		"Allow",
		"Steer",
		"Block",
	]);

	if (choice === "Allow") return;
	if (choice === "Steer") {
		return steer(ctx, command, `Blocked command: ${command}`);
	}
	return { block: true, reason: `User blocked: ${command}` };
}

// ---- Extension entry point ----

export default function gitGuardian(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!ctx.hasUI) return;

		const command = event.input.command;

		if (/\bgit\s+commit\b/.test(command)) {
			return reviewCommit(command, pi, ctx);
		}

		for (const { pattern, severity, description } of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(command)) {
				return confirmDestructive(command, severity, description, ctx);
			}
		}
	});
}
