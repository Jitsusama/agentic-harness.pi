/**
 * Commit guardian review — presents the commit message for
 * approval with validation indicators and hold-to-reveal
 * steer annotations.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CommandGuardian, GuardianResult } from "../lib/guardian/types.js";
import { prompt } from "../lib/ui/panel-new.js";
import { formatSteer } from "../lib/ui/steer.js";
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
		_event: { input: { command: string } },
		ctx: ExtensionContext,
	): Promise<GuardianResult> {
		const result = await prompt(ctx, {
			content: renderCommitContent(parsed.message, parsed.isAmend),
			actions: COMMIT_ACTIONS,
		});

		if (!result) {
			return {
				block: true,
				reason: "User cancelled the commit review.",
			};
		}

		if (result.type === "steer") {
			return formatSteer(result.note, `Original commit:\n${parsed.message}`);
		}

		if (result.type === "action") {
			if (result.value === "a") {
				// Approve — if the user added a note, treat as steer
				if (result.note) {
					return formatSteer(
						result.note,
						`Original commit:\n${parsed.message}`,
					);
				}
				return undefined;
			}

			// Reject — if there's a note, include it
			if (result.note) {
				return formatSteer(result.note, `Original commit:\n${parsed.message}`);
			}
			return {
				block: true,
				reason:
					"User rejected the commit. Ask for guidance on the commit description.",
			};
		}
	},
};
