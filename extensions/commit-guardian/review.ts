/**
 * Commit review flow — delegates to the shared review loop
 * with a single-field config and commit-specific rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	reviewLoop,
	type SingleField,
} from "../shared/review-loop.js";
import {
	extractMessage,
	splitAtCommit,
	extractFlags,
	buildHeredoc,
} from "./parse.js";
import { renderCommitContent } from "./validate.js";

const COMMIT_ACTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
];

/**
 * Review a git commit command before execution.
 */
export async function reviewCommit(
	event: { input: { command: string } },
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	const command = event.input.command;
	const message = extractMessage(command);
	if (!message) return;

	const isAmend = /--amend\b/.test(command);
	const { prefix, commitPart } = splitAtCommit(command);
	const flags = extractFlags(commitPart);

	const field: SingleField = {
		kind: "single",
		value: message,
		editorPrompt: "Edit commit message:",
	};

	return reviewLoop(ctx, {
		actions: COMMIT_ACTIONS,
		content: (theme, width) =>
			renderCommitContent(field.value, isAmend)(theme, width),
		field,
		onApprove: () => {
			if (field.value !== message) {
				const heredoc = buildHeredoc(field.value, flags);
				(event.input as { command: string }).command = prefix
					? `${prefix} && ${heredoc}`
					: heredoc;
			}
		},
		entityName: "commit",
		steerContext: message,
	});
}
