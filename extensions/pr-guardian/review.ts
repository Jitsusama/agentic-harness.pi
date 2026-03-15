/**
 * PR guardian — detects gh pr create/edit commands, parses
 * title and body, and presents them for review with markdown
 * rendering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CommandGuardian, GuardianResult } from "../lib/guardian/types.js";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import { prompt } from "../lib/ui/panel.js";
import { formatSteer } from "../lib/ui/steer.js";
import { isPrCommand, type PrCommand, parsePrCommand } from "./parse.js";

const PR_ACTIONS = [
	{ key: "a", label: "Approve" },
	{ key: "r", label: "Reject" },
];

export const prGuardian: CommandGuardian<PrCommand> = {
	detect(command) {
		return isPrCommand(command);
	},

	parse(command) {
		return parsePrCommand(command);
	},

	async review(
		parsed: PrCommand,
		_event: { input: { command: string } },
		ctx: ExtensionContext,
	): Promise<GuardianResult> {
		const isEdit = parsed.action === "edit";
		const result = await prompt(ctx, {
			title: isEdit ? "PR Edit" : "New PR",
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
			actions: PR_ACTIONS,
		});

		if (!result) {
			return { block: true, reason: "User cancelled the PR review." };
		}

		const steerContext = [
			parsed.title ? `Title: ${parsed.title}` : null,
			"",
			parsed.body ?? "",
		]
			.filter((l) => l !== null)
			.join("\n");

		if (result.type === "steer") {
			return formatSteer(result.note, `Original PR:\n${steerContext}`);
		}

		if (result.type === "action") {
			if (result.value === "a") {
				if (result.note) {
					return formatSteer(result.note, `Original PR:\n${steerContext}`);
				}
				return undefined;
			}
			if (result.note) {
				return formatSteer(result.note, `Original PR:\n${steerContext}`);
			}
			return {
				block: true,
				reason: "User rejected the PR. Ask for guidance on the PR description.",
			};
		}
	},
};
