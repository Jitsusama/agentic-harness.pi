/**
 * Git Guardian Extension
 *
 * Safety net for git operations. The conventional-commits skill
 * teaches the agent to write good messages in heredoc format —
 * this extension just lets you review before anything lands.
 *
 * 1. Commit review — intercepts git commit, shows the message
 *    with validation indicators, and lets you approve, edit,
 *    steer, or reject. Normalizes all commits to heredoc format.
 *
 * 2. Destructive command protection — confirms before dangerous
 *    git operations with the same steer option.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { showGate, formatSteer } from "../shared/gate.js";

// ---- Destructive command patterns ----

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

// ---- Commit message validation ----

interface CommitValidation {
	subjectLength: number;
	subjectOk: boolean;
	bodyWrapOk: boolean;
	bodyLongestLine: number;
	bodyLongestLineNum: number;
	conventionalOk: boolean;
}

function validateMessage(message: string): CommitValidation {
	const lines = message.split("\n");
	const subject = lines[0] || "";
	const bodyLines = lines.length > 2 ? lines.slice(2) : [];

	const subjectLength = subject.length;
	const subjectOk = subjectLength <= 50;

	let bodyLongestLine = 0;
	let bodyLongestLineNum = 0;
	for (let i = 0; i < bodyLines.length; i++) {
		if (bodyLines[i].length > bodyLongestLine) {
			bodyLongestLine = bodyLines[i].length;
			bodyLongestLineNum = i + 3;
		}
	}
	const bodyWrapOk = bodyLongestLine <= 72;

	const conventionalOk = /^[a-z]+(\([a-z0-9/_-]+\))?!?:\s/.test(
		subject,
	);

	return {
		subjectLength,
		subjectOk,
		bodyWrapOk,
		bodyLongestLine,
		bodyLongestLineNum,
		conventionalOk,
	};
}

function renderValidation(
	v: CommitValidation,
	theme: { fg: (color: string, text: string) => string },
): string {
	const parts: string[] = [];
	const dot = theme.fg("dim", " · ");

	if (v.subjectOk) {
		parts.push(theme.fg("success", `✓ ${v.subjectLength} chars`));
	} else {
		parts.push(
			theme.fg(
				"warning",
				`⚠ ${v.subjectLength} chars (limit: 50)`,
			),
		);
	}

	if (v.bodyLongestLine > 0) {
		if (v.bodyWrapOk) {
			parts.push(theme.fg("success", "✓ wrap"));
		} else {
			parts.push(
				theme.fg(
					"warning",
					`⚠ line ${v.bodyLongestLineNum}: ${v.bodyLongestLine} chars`,
				),
			);
		}
	}

	if (v.conventionalOk) {
		parts.push(theme.fg("success", "✓ conventional"));
	} else {
		parts.push(theme.fg("warning", "⚠ not conventional"));
	}

	return ` ${parts.join(dot)}`;
}

// ---- Message extraction ----

function extractMessage(command: string): string | null {
	const heredoc = command.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2]!;

	const normalized = command.replace(/-am\s+/g, "-a -m ");
	const messages: string[] = [];
	const re =
		/(?:^|\s)-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
	let match;
	while ((match = re.exec(normalized)) !== null) {
		messages.push(
			(match[1] ?? match[2] ?? match[3] ?? "").replace(
				/\\(.)/g,
				"$1",
			),
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

// ---- Commit review ----

async function reviewCommit(
	event: { input: { command: string } },
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	const command = event.input.command;
	const message = extractMessage(command);
	if (!message) return;


	const isAmend = /--amend\b/.test(command);
	const { prefix, commitPart } = splitAtCommit(command);
	const flags = extractCommitFlags(commitPart);
	let current = message;

	while (true) {
		const validation = validateMessage(current);
		const subject = current.split("\n")[0] || "";
		const bodyLines = current.split("\n").slice(2);

		const result = await showGate(ctx, {
			content: (theme, _width) => {
				const lines: string[] = [];

				// Subject line
				lines.push(theme.fg("text", ` ${subject}`));

				// Body
				if (bodyLines.length > 0) {
					lines.push("");
					for (const line of bodyLines) {
						lines.push(` ${theme.fg("text", line)}`);
					}
				}

				// Amend note
				if (isAmend) {
					lines.push("");
					lines.push(
						theme.fg("warning", " ⚠ Amends previous commit"),
					);
				}

				// Validation
				lines.push("");
				lines.push(renderValidation(validation, theme));

				return lines;
			},
			options: [
				{ label: "Approve", value: "approve" },
				{ label: "Edit", value: "edit" },
				{ label: "Reject", value: "reject" },
			],
			steerContext: current,
		});

		if (!result) {
			return {
				block: true,
				reason: "User cancelled the commit review.",
			};
		}

		if (result.value === "approve") {
			if (current !== message) {
				// Message was edited — rewrite the original command
				// so the bash tool executes with the updated message.
				const heredoc = buildHeredoc(current, flags);
				const fullCmd = prefix
					? `${prefix} && ${heredoc}`
					: heredoc;
				(event.input as { command: string }).command = fullCmd;
			}
			// Let the (possibly rewritten) original command run
			// normally — output renders in default color.
			return;
		}

		if (result.value === "edit") {
			const edited = await ctx.ui.editor(
				"Edit commit message:",
				current,
			);
			if (edited !== undefined && edited.trim()) {
				current = edited;
			}
			continue;
		}

		if (result.value === "steer") {
			return formatSteer(
				result.feedback!,
				`Original message:\n${current}`,
			);
		}

		// Reject
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


	const result = await showGate(ctx, {
		content: (theme, _width) => [
			theme.fg("text", ` ${icon} ${label}`),
			"",
			` ${theme.fg("text", command)}`,
			` ${theme.fg("muted", description)}`,
		],
		options: [
			{ label: "Allow", value: "allow" },
			{ label: "Block", value: "block" },
		],
		steerContext: command,
	});

	if (!result || result.value === "block") {
		return { block: true, reason: `User blocked: ${command}` };
	}

	if (result.value === "steer") {
		return formatSteer(
			result.feedback!,
			`Blocked command: ${command}`,
		);
	}

	// Allow
	return;
}

// ---- Extension entry point ----

export default function gitGuardian(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!ctx.hasUI) return;

		const command = event.input.command;

		if (/\bgit\s+commit\b/.test(command)) {
			return reviewCommit(event, pi, ctx);
		}

		for (const {
			pattern,
			severity,
			description,
		} of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(command)) {
				return confirmDestructive(
					command,
					severity,
					description,
					ctx,
				);
			}
		}
	});
}
