/**
 * Command parsing — shared utilities for extracting content
 * from bash commands intercepted by guardian extensions.
 *
 * Used by pr-guardian, issue-guardian, and commit-guardian
 * for parsing gh and git commands.
 */

// ---- Flag and body extraction ----

/** Extract a --flag "value" or --flag 'value' from a command string. */
export function extractFlag(command: string, flag: string): string | null {
	// Double-quoted
	const dq = new RegExp(`--${flag}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
	const dqMatch = command.match(dq);
	if (dqMatch) return dqMatch[1]!.replace(/\\(.)/g, "$1");

	// Single-quoted
	const sq = new RegExp(`--${flag}\\s+'([^']*)'`);
	const sqMatch = command.match(sq);
	if (sqMatch) return sqMatch[1]!;

	return null;
}

/** Extract the body from a command, supporting heredoc and --body flag. */
export function extractBody(fullCommand: string, entityPart: string): string | null {
	// Heredoc: --body-file - <<'DELIM'\nbody\nDELIM
	const heredoc = fullCommand.match(
		/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
	);
	if (heredoc) return heredoc[2]!;

	// --body flag
	return extractFlag(entityPart, "body");
}

/** Safe shell quoting. */
export function quote(s: string): string {
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

// ---- Command splitting ----

/**
 * Split a compound command at the last separator before the
 * target command. Returns the prefix (everything before) and
 * the target command portion.
 *
 * Examples:
 *   splitAtCommand("cd /path && gh pr create ...", /gh\s+pr\s+.../)
 *   splitAtCommand("git add -A && git commit ...", /git\s+commit\b/)
 */
export function splitAtCommand(
	command: string,
	targetPattern: RegExp,
): { prefix: string | null; target: string } {
	// Build a regex that captures everything before the last separator
	// before the target pattern
	const source = targetPattern.source;
	const re = new RegExp(
		`^(.*)\\s*(?:&&|;)\\s*(${source}[\\s\\S]*)$`,
	);
	const match = command.match(re);
	if (match?.[1]?.trim()) {
		return { prefix: match[1].trim(), target: match[2]! };
	}
	return { prefix: null, target: command };
}

// ---- Entity number extraction ----

/** Extract a number from a command (e.g., PR number from "gh pr edit 42"). */
export function extractEntityNumber(
	commandPart: string,
	pattern: RegExp,
): string | null {
	const match = commandPart.match(pattern);
	return match ? match[1]! : null;
}

// ---- gh command detection ----

/** Detect whether a bash command contains a specific gh subcommand. */
export function isGhCommand(command: string, subcommand: string): boolean {
	const re = new RegExp(`\\bgh\\s+${subcommand}\\s+(create|edit)\\b`);
	return re.test(command);
}

// ---- gh command rebuilding ----

export interface GhRebuildConfig {
	/** "pr" or "issue" */
	entity: string;
	/** "create" or "edit" */
	action: string;
	/** Entity number for edit commands. */
	entityNumber?: string | null;
	/** Prefix command (cd /path, etc.) */
	prefix?: string | null;
	/** Extra flags to preserve. */
	extraFlags?: string[];
	/** Title. */
	title?: string | null;
	/** Body content. */
	body: string;
	/** Heredoc delimiter. */
	heredocDelim: string;
}

/** Rebuild a gh command with an edited body. */
export function rebuildGhCommand(config: GhRebuildConfig): string {
	const parts: string[] = ["gh", config.entity, config.action];

	if (config.action === "edit" && config.entityNumber) {
		parts.push(config.entityNumber);
	}

	if (config.extraFlags && config.extraFlags.length > 0) {
		parts.push(...config.extraFlags);
	}

	if (config.title) {
		parts.push("--title", quote(config.title));
	}

	parts.push("--body-file", "-");

	const heredoc = [
		parts.join(" ") + ` <<'${config.heredocDelim}'`,
		config.body,
		config.heredocDelim,
	].join("\n");

	return config.prefix ? `${config.prefix} && ${heredoc}` : heredoc;
}

// ---- Multi-value flag extraction ----

/**
 * Extract flags that can appear multiple times (--label, --assignee, etc.).
 * Returns an array of [flagName, value] pairs.
 */
export function extractMultiFlags(
	commandPart: string,
	names: string[],
): Array<[string, string]> {
	const results: Array<[string, string]> = [];
	const multiRe = (name: string) =>
		new RegExp(`--(?:add-)?${name}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, "g");

	for (const name of names) {
		let match;
		const re = multiRe(name);
		while ((match = re.exec(commandPart)) !== null) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value) results.push([name, value]);
		}
	}
	return results;
}
