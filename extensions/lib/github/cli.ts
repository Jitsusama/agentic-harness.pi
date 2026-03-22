/**
 * GitHub CLI command parsing: detection, entity number extraction,
 * multi-value flag extraction and command rebuilding for gh
 * pr/issue create/edit commands.
 *
 * Depends on shell-level primitives from ./command.ts for quoting.
 */

import { quote } from "../guardian/shell.js";

/** Extract a number from a command (e.g., PR number from "gh pr edit 42"). */
export function extractEntityNumber(
	commandPart: string,
	pattern: RegExp,
): string | null {
	const match = commandPart.match(pattern);
	return match?.[1] ?? null;
}

/** Detect whether a bash command contains a specific gh subcommand. */
export function isGhCommand(command: string, subcommand: string): boolean {
	const re = new RegExp(`\\bgh\\s+${subcommand}\\s+(create|edit)\\b`);
	return re.test(command);
}

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
		`${parts.join(" ")} <<'${config.heredocDelim}'`,
		config.body,
		config.heredocDelim,
	].join("\n");

	return config.prefix ? `${config.prefix} && ${heredoc}` : heredoc;
}

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
		const re = multiRe(name);
		for (const match of commandPart.matchAll(re)) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value) results.push([name, value]);
		}
	}
	return results;
}
