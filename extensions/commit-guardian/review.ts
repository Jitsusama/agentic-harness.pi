/**
 * Commit guardian review: presents the commit message for
 * approval with validation indicators and hold-to-reveal
 * annotations.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { formatRedirectBlock, promptSingle } from "../../lib/ui/index.js";
import {
	ALLOW,
	type CommandGuardian,
	type GuardianResult,
} from "../lib/guardian/types.js";
import { extractCommitFlags, extractMessage, splitAtCommit } from "./parse.js";
import { type CommitValidation, validate } from "./validate.js";

const COMMIT_ACTIONS = [{ key: "r", label: "Reject" }];

interface CommitParsed {
	message: string;
	isAmend: boolean;
	prefix: string | null;
	flags: string[];
}

/** Guardian that intercepts git commit commands and presents the message for review. */
export const commitGuardian: CommandGuardian<CommitParsed> = {
	detect(command) {
		return /\bgit\s+commit\b/.test(command);
	},

	parse(command) {
		const message = extractMessage(command);
		if (!message) return null;

		const isAmend = /--amend\b/.test(command);
		const { prefix, commitPart } = splitAtCommit(command);
		const flags = extractCommitFlags(commitPart);

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
			// Reject
			if (result.key === "r") {
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

			// Enter (approve)
			if (result.note) {
				return formatRedirectBlock(
					result.note,
					`Original commit:\n${parsed.message}`,
				);
			}
			return ALLOW;
		}
	},
};

/** Render validation as a compact indicator line. */
function renderValidation(v: CommitValidation, theme: Theme): string {
	const parts: string[] = [];
	const dot = theme.fg("dim", " · ");

	parts.push(
		v.subjectOk
			? theme.fg("success", `✓ ${v.subjectLength} chars`)
			: theme.fg("warning", `⚠ ${v.subjectLength} chars (limit: 50)`),
	);

	if (v.bodyLongestLine > 0) {
		parts.push(
			v.bodyWrapOk
				? theme.fg("success", "✓ wrap")
				: theme.fg(
						"warning",
						`⚠ line ${v.bodyLongestLineNum}: ${v.bodyLongestLine} chars`,
					),
		);
	}

	parts.push(
		v.conventionalOk
			? theme.fg("success", "✓ conventional")
			: theme.fg("warning", "⚠ not conventional"),
	);

	return ` ${parts.join(dot)}`;
}

/** Render a commit message as gate content lines. */
function renderCommitContent(
	message: string,
	isAmend: boolean,
): (theme: Theme, width: number) => string[] {
	const lines = message.split("\n");
	const subject = lines[0] || "";
	const bodyLines = lines.length > 2 ? lines.slice(2) : [];
	const validation = validate(message);

	return (theme, _width) => {
		const out: string[] = [];

		out.push(theme.fg("text", ` ${subject}`));

		if (bodyLines.length > 0) {
			out.push("");
			for (const line of bodyLines) {
				out.push(` ${theme.fg("text", line)}`);
			}
		}

		if (isAmend) {
			out.push("");
			out.push(theme.fg("warning", " ⚠ Amends previous commit"));
		}

		out.push("");
		out.push(renderValidation(validation, theme));

		return out;
	};
}
