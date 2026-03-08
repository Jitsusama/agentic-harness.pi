/**
 * Commit review flow — show the gate, handle approve/edit/steer/reject.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showGate, formatSteer } from "../shared/gate.js";
import { extractMessage, splitAtCommit, extractFlags, buildHeredoc } from "./parse.js";
import { renderCommitContent } from "./validate.js";

const COMMIT_OPTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
];

/**
 * Review a git commit command before execution.
 *
 * Takes the raw event (not just the command string) because
 * on the edit→approve path we mutate event.input.command to
 * rewrite the bash command with the edited message. This lets
 * pi's bash tool execute the updated command directly, so
 * output renders in the normal color instead of error-red.
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
	let current = message;

	while (true) {
		const result = await showGate(ctx, {
			content: renderCommitContent(current, isAmend),
			options: COMMIT_OPTIONS,
			steerContext: current,
		});

		if (!result) {
			return { block: true, reason: "User cancelled the commit review." };
		}

		switch (result.value) {
			case "approve": {
				if (current !== message) {
					const heredoc = buildHeredoc(current, flags);
					(event.input as { command: string }).command = prefix
						? `${prefix} && ${heredoc}`
						: heredoc;
				}
				return;
			}

			case "edit": {
				const edited = await ctx.ui.editor("Edit commit message:", current);
				if (edited !== undefined && edited.trim()) {
					current = edited;
				}
				continue;
			}

			case "steer":
				return formatSteer(result.feedback!, `Original message:\n${current}`);

			default:
				return {
					block: true,
					reason: "User rejected the commit. Ask for guidance on the commit message.",
				};
		}
	}
}
