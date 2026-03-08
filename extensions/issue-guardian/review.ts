/**
 * Issue guardian — detects gh issue create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { reviewLoop, titleBodyField } from "../lib/guardian/review-loop.js";
import type { CommandGuardian, GuardianResult } from "../lib/guardian/types.js";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import {
	type IssueCommand,
	isIssueCommand,
	parseIssueCommand,
	rebuildCommand,
} from "./parse.js";

const ISSUE_ACTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
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
		const field = titleBodyField(
			parsed.title,
			parsed.body ?? "",
			"Edit issue description:",
		);

		const originalBody = parsed.body;
		const originalTitle = parsed.title;

		const result = await reviewLoop(ctx, {
			actions: ISSUE_ACTIONS,
			content: (theme, width) => {
				const out: string[] = [];
				const isEdit = parsed.action === "edit";

				out.push(theme.fg("dim", isEdit ? " Issue Edit" : " New Issue"));
				out.push("");

				if (field.title) {
					out.push(theme.fg("text", ` ${theme.bold(field.title)}`));
					out.push("");
				}

				for (const line of renderMarkdown(field.body, theme, width)) {
					out.push(line);
				}

				return out;
			},
			field,
			entityName: "issue",
			steerContext: field.steerText(),
		});

		if (result) return result;

		// Approve — check if title or body was edited
		if (field.body !== originalBody || field.title !== originalTitle) {
			return {
				rewrite: rebuildCommand(parsed, field.body, field.title ?? undefined),
			};
		}
	},
};
