/**
 * Issue review flow — delegates to the shared review loop
 * with a title+body config and markdown rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../lib/content-renderer.js";
import { reviewLoop, type TitleBodyField } from "../lib/review-loop.js";
import { type IssueCommand, rebuildCommand } from "./parse.js";

const ISSUE_ACTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
];

/**
 * Review a gh issue create/edit command before execution.
 */
export async function reviewIssue(
	event: { input: { command: string } },
	parsed: IssueCommand,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	const field: TitleBodyField = {
		kind: "title-body",
		title: parsed.title,
		body: parsed.body ?? "",
		editorPrompt: "Edit issue description:",
	};

	const originalBody = parsed.body;
	const originalTitle = parsed.title;

	return reviewLoop(ctx, {
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
		onApprove: () => {
			if (field.body !== originalBody || field.title !== originalTitle) {
				(event.input as { command: string }).command = rebuildCommand(
					parsed,
					field.body,
					field.title ?? undefined,
				);
			}
		},
		entityName: "issue",
		steerContext: [field.title ? `Title: ${field.title}` : null, "", field.body]
			.filter((l) => l !== null)
			.join("\n"),
	});
}
