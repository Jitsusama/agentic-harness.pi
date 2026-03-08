/**
 * PR review flow — delegates to the shared review loop
 * with a title+body config and markdown rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { reviewLoop, titleBodyField } from "../lib/guardian/review-loop.js";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import { type PrCommand, rebuildCommand } from "./parse.js";

const PR_ACTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
];

/**
 * Review a gh pr create/edit command before execution.
 */
export async function reviewPr(
	event: { input: { command: string } },
	parsed: PrCommand,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	const field = titleBodyField(
		parsed.title,
		parsed.body ?? "",
		"Edit PR description:",
	);

	const originalBody = parsed.body;
	const originalTitle = parsed.title;

	return reviewLoop(ctx, {
		actions: PR_ACTIONS,
		content: (theme, width) => {
			const out: string[] = [];
			const isEdit = parsed.action === "edit";

			out.push(theme.fg("dim", isEdit ? " PR Edit" : " New PR"));
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
		entityName: "PR",
		steerContext: field.steerText(),
	});
}
