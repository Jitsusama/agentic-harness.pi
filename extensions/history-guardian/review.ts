/**
 * History guardian: detects destructive git commands and
 * requires allow/block confirmation before execution.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	formatRedirectBlock,
	promptSingle,
	renderMarkdown,
} from "../../lib/ui/index.js";
import {
	ALLOW,
	type CommandGuardian,
	type GuardianResult,
} from "../lib/guardian/types.js";
import {
	DESTRUCTIVE_PATTERNS,
	type DestructivePattern,
	type Severity,
} from "./patterns.js";

const DESTRUCTIVE_ACTIONS = [{ key: "r", label: "Reject" }];

interface DestructiveMatch {
	command: string;
	severity: Severity;
	description: string;
}

/** Guardian that intercepts destructive git commands and requires confirmation. */
export const historyGuardian: CommandGuardian<DestructiveMatch> = {
	detect(command) {
		return DESTRUCTIVE_PATTERNS.some((p: DestructivePattern) =>
			p.pattern.test(command),
		);
	},

	parse(command) {
		for (const { pattern, severity, description } of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(command)) {
				return { command, severity, description };
			}
		}
		return null;
	},

	async review(
		parsed: DestructiveMatch,
		ctx: ExtensionContext,
	): Promise<GuardianResult> {
		const icon = parsed.severity === "irrecoverable" ? "⛔" : "⚠";
		const title =
			parsed.severity === "irrecoverable"
				? "Destructive Command"
				: "Risky Command";

		const markdown = [
			`${icon} **${title}**`,
			"",
			"```bash",
			parsed.command,
			"```",
			"",
			parsed.description,
		].join("\n");

		const result = await promptSingle(ctx, {
			title,
			content: (theme, width) => renderMarkdown(markdown, theme, width),
			actions: DESTRUCTIVE_ACTIONS,
		});

		if (!result) {
			return { block: true, reason: "User cancelled the command review." };
		}

		if (result.type === "redirect") {
			return formatRedirectBlock(
				result.note,
				`Original command:\n${parsed.command}`,
			);
		}

		if (result.type === "action") {
			const context = `Original command:\n${parsed.command}`;

			// Reject
			if (result.key === "r") {
				if (result.note) {
					return formatRedirectBlock(result.note, context);
				}
				return {
					block: true,
					reason: `User blocked: ${parsed.command}`,
				};
			}

			// Enter (approve)
			if (result.note) {
				return formatRedirectBlock(result.note, context);
			}
			return ALLOW;
		}
	},
};
