/**
 * Commit guardian — detects git commit commands, parses the
 * message, and presents it for review with validation indicators.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { reviewLoop, singleField } from "../lib/guardian/review-loop.js";
import type { CommandGuardian, GuardianResult } from "../lib/guardian/types.js";
import {
	buildHeredoc,
	extractFlags,
	extractMessage,
	splitAtCommit,
} from "./parse.js";
import { renderCommitContent } from "./validate.js";

const COMMIT_ACTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
];

interface CommitParsed {
	message: string;
	isAmend: boolean;
	prefix: string | null;
	flags: string[];
}

export const commitGuardian: CommandGuardian<CommitParsed> = {
	detect(command) {
		return /\bgit\s+commit\b/.test(command);
	},

	parse(command) {
		const message = extractMessage(command);
		if (!message) return null;

		const isAmend = /--amend\b/.test(command);
		const { prefix, commitPart } = splitAtCommit(command);
		const flags = extractFlags(commitPart);

		return { message, isAmend, prefix, flags };
	},

	async review(
		parsed: CommitParsed,
		_event: { input: { command: string } },
		ctx: ExtensionContext,
	): Promise<GuardianResult> {
		const field = singleField(parsed.message, "Edit commit message:");

		const result = await reviewLoop(ctx, {
			actions: COMMIT_ACTIONS,
			content: (theme, width) =>
				renderCommitContent(field.value, parsed.isAmend)(theme, width),
			field,
			entityName: "commit",
			steerContext: parsed.message,
		});

		if (result) return result;

		// Approve — check if the message was edited
		if (field.value !== parsed.message) {
			const heredoc = buildHeredoc(field.value, parsed.flags);
			const rewrite = parsed.prefix
				? `${parsed.prefix} && ${heredoc}`
				: heredoc;
			return { rewrite };
		}
	},
};
