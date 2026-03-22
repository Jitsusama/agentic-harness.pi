/**
 * Commit guardian review: presents the commit message for
 * approval with validation indicators and hold-to-reveal
 * annotations.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	ALLOW,
	type CommandGuardian,
	type GuardianResult,
} from "../lib/guardian/types.js";
import { promptSingle } from "../lib/ui/panel.js";
import { formatRedirectBlock } from "../lib/ui/redirect.js";
import { extractFlags, extractMessage, splitAtCommit } from "./parse.js";
import { renderCommitContent } from "./validate.js";

const COMMIT_ACTIONS = [
	{ key: "a", label: "Approve" },
	{ key: "r", label: "Reject" },
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
		ctx: ExtensionContext,
	): Promise<GuardianResult> {
		const result = await promptSingle(ctx, {
			title: parsed.isAmend ? "Amend Commit" : "Commit",
			content: renderCommitContent(parsed.message, parsed.isAmend),
			actions: COMMIT_ACTIONS,
		});

		if (!result) {
			return {
				block: true,
				reason: "User cancelled the commit review.",
			};
		}

		if (result.type === "redirect") {
			return formatRedirectBlock(
				result.note,
				`Original commit:\n${parsed.message}`,
			);
		}

		if (result.type === "action") {
			if (result.key === "a") {
				// If the user added a note on approve, we treat it as a redirect.
				if (result.note) {
					return formatRedirectBlock(
						result.note,
						`Original commit:\n${parsed.message}`,
					);
				}
				return ALLOW;
			}

			// If there's a note on reject, we include it as redirect feedback.
			if (result.note) {
				return formatRedirectBlock(
					result.note,
					`Original commit:\n${parsed.message}`,
				);
			}
			return {
				block: true,
				reason:
					"User rejected the commit. Ask for guidance on the commit description.",
			};
		}
	},
};
