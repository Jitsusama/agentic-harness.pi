/**
 * History guardian: detects destructive git commands and
 * requires allow/block confirmation before execution.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CommandGuardian, GuardianResult } from "../lib/guardian/types.js";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import { prompt } from "../lib/ui/panel.js";
import { formatSteer } from "../lib/ui/steer.js";
import {
	DESTRUCTIVE_PATTERNS,
	type DestructivePattern,
	type Severity,
} from "./patterns.js";

const DESTRUCTIVE_ACTIONS = [
	{ key: "a", label: "Allow" },
	{ key: "b", label: "Block" },
];

interface DestructiveMatch {
	command: string;
	severity: Severity;
	description: string;
}

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
		_event: { input: { command: string } },
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

		const result = await prompt(ctx, {
			title,
			content: (theme, width) => renderMarkdown(markdown, theme, width),
			actions: DESTRUCTIVE_ACTIONS,
		});

		if (!result) {
			return { block: true, reason: "User cancelled the command review." };
		}

		if (result.type === "steer") {
			return formatSteer(result.note, `Original command:\n${parsed.command}`);
		}

		if (result.type === "action" && result.value === "a") {
			return undefined;
		}

		return { block: true, reason: `User blocked: ${parsed.command}` };
	},
};
