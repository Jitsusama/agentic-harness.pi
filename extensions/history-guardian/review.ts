/**
 * History guardian: detects destructive git commands and
 * requires allow/block confirmation before execution.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type DestructiveMatch,
	detectDestructiveCommand,
} from "@jitsusama/agentic-harness.core/guardian/history-gate";
import {
	ALLOW,
	type CommandGuardian,
	formatRedirectBlock,
	type GuardianResult,
} from "../../lib/guardian/index.js";
import { promptSingle, renderMarkdown } from "../../lib/ui/index.js";

const DESTRUCTIVE_ACTIONS = [{ key: "r", label: "Reject" }];

/** Guardian that intercepts destructive git commands and requires confirmation. */
export const historyGuardian: CommandGuardian<DestructiveMatch> = {
	detect(command) {
		return detectDestructiveCommand(command) !== null;
	},

	parse(command) {
		return detectDestructiveCommand(command);
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
