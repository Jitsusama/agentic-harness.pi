/**
 * Issue guardian — detects gh issue create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CommandGuardian, GuardianResult } from "../lib/guardian/types.js";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import { prompt } from "../lib/ui/panel.js";
import { formatSteer } from "../lib/ui/steer.js";
import {
	type IssueCommand,
	isIssueCommand,
	parseIssueCommand,
} from "./parse.js";

const ISSUE_ACTIONS = [
	{ key: "a", label: "Approve" },
	{ key: "r", label: "Reject" },
];

export const issueGuardian: CommandGuardian<IssueCommand> = {
	detect(command) {
		return isIssueCommand(command);
	},

	parse(command) {
		return parseIssueCommand(command);
	},

	async review(
		parsed: IssueCommand,
		_event: { input: { command: string } },
		ctx: ExtensionContext,
	): Promise<GuardianResult> {
		const isEdit = parsed.action === "edit";
		const result = await prompt(ctx, {
			title: isEdit ? "Issue Edit" : "New Issue",
			content: (theme, width) => {
				const out: string[] = [];

				if (parsed.title) {
					out.push(theme.fg("text", ` ${theme.bold(parsed.title)}`));
					out.push("");
				}

				if (parsed.body) {
					for (const line of renderMarkdown(parsed.body, theme, width)) {
						out.push(line);
					}
				}

				return out;
			},
			actions: ISSUE_ACTIONS,
		});

		if (!result) {
			return { block: true, reason: "User cancelled the issue review." };
		}

		const steerContext = [
			parsed.title ? `Title: ${parsed.title}` : null,
			"",
			parsed.body ?? "",
		]
			.filter((l) => l !== null)
			.join("\n");

		if (result.type === "steer") {
			return formatSteer(result.note, `Original issue:\n${steerContext}`);
		}

		if (result.type === "action") {
			if (result.value === "a") {
				if (result.note) {
					return formatSteer(result.note, `Original issue:\n${steerContext}`);
				}
				return undefined;
			}
			if (result.note) {
				return formatSteer(result.note, `Original issue:\n${steerContext}`);
			}
			return {
				block: true,
				reason:
					"User rejected the issue. Ask for guidance on the issue description.",
			};
		}
	},
};
