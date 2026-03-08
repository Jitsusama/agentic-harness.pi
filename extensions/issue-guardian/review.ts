/**
 * Issue review flow — show the gate, handle approve/edit/steer/reject.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { showGate, formatSteer } from "../shared/gate.js";
import { type IssueCommand, rebuildCommand } from "./parse.js";

const ISSUE_OPTIONS = [
	{ label: "Approve", value: "approve" },
	{ label: "Edit", value: "edit" },
	{ label: "Reject", value: "reject" },
];

/** Render the issue content for the gate. */
function renderIssueContent(
	parsed: IssueCommand,
	currentBody: string,
	currentTitle: string | null,
): (theme: Theme, width: number) => string[] {
	return (theme, width) => {
		const out: string[] = [];
		const isEdit = parsed.action === "edit";

		// Header
		out.push(
			theme.fg("dim", isEdit ? " Issue Edit" : " New Issue"),
		);
		out.push("");

		// Title
		if (currentTitle) {
			out.push(theme.fg("text", ` ${theme.bold(currentTitle)}`));
			out.push("");
		}

		// Body — render with light formatting
		for (const line of currentBody.split("\n")) {
			if (line.startsWith("###")) {
				out.push(theme.fg("accent", ` ${line}`));
			} else if (line.startsWith("> ")) {
				out.push(theme.fg("dim", ` ${line}`));
			} else if (line.startsWith("- ") || line.startsWith("* ")) {
				out.push(theme.fg("text", ` ${line}`));
			} else if (line.startsWith("```")) {
				out.push(theme.fg("dim", ` ${line}`));
			} else {
				out.push(` ${line}`);
			}
		}

		return out;
	};
}

/**
 * Review a gh issue create/edit command before execution.
 */
export async function reviewIssue(
	event: { input: { command: string } },
	parsed: IssueCommand,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	let currentBody = parsed.body!;
	let currentTitle = parsed.title;

	while (true) {
		const steerContext = [
			currentTitle ? `Title: ${currentTitle}` : null,
			"",
			currentBody,
		]
			.filter((l) => l !== null)
			.join("\n");

		const result = await showGate(ctx, {
			content: renderIssueContent(parsed, currentBody, currentTitle),
			options: ISSUE_OPTIONS,
			steerContext,
		});

		if (!result) {
			return {
				block: true,
				reason: "User cancelled the issue review.",
			};
		}

		switch (result.value) {
			case "approve": {
				// Rebuild command if anything was edited
				if (
					currentBody !== parsed.body ||
					currentTitle !== parsed.title
				) {
					(event.input as { command: string }).command =
						rebuildCommand(parsed, currentBody, currentTitle ?? undefined);
				}
				return;
			}

			case "edit": {
				const editContent = [
					currentTitle ? `# ${currentTitle}` : null,
					"",
					currentBody,
				]
					.filter((l) => l !== null)
					.join("\n");

				const edited = await ctx.ui.editor(
					"Edit issue description:",
					editContent,
				);

				if (edited !== undefined && edited.trim()) {
					// If first line starts with #, treat it as the title
					const lines = edited.split("\n");
					if (lines[0]?.startsWith("# ")) {
						currentTitle = lines[0].replace(/^#\s+/, "");
						currentBody = lines
							.slice(1)
							.join("\n")
							.replace(/^\n+/, "");
					} else {
						currentBody = edited;
					}
				}
				continue;
			}

			case "steer":
				return formatSteer(
					result.feedback!,
					`Original issue:\nTitle: ${currentTitle ?? "(none)"}\n\n${currentBody}`,
				);

			default:
				return {
					block: true,
					reason: "User rejected the issue. Ask for guidance on the issue description.",
				};
		}
	}
}
