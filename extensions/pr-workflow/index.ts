/**
 * PR Workflow Extension
 *
 * Conversation-first PR review and reply. The user prompts in
 * prose, the agent calls the `pr_workflow` tool, and the
 * extension grows panels, narration and findings around the
 * conversation rather than steering it from a menu.
 *
 * At this scaffold stage the extension registers a single
 * tool with one `load` action so the wiring is real but the
 * substantive behaviour (council, findings, post gates,
 * stacks, fix loop, neovim companion) lands in follow-up
 * commits, one capability at a time, each with its own tests.
 *
 * No slash commands. No global keymaps. No auto-activation.
 * Every effect originates from a tool call the user (or the
 * agent on the user's behalf) initiated.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createPrWorkflowState } from "./state.js";

export default function prWorkflow(pi: ExtensionAPI) {
	const state = createPrWorkflowState();

	pi.registerTool({
		name: "pr_workflow",
		label: "PR Workflow",
		description:
			"Conversation-first pull request review and reply. Load a PR, " +
			"discuss findings, run multi-model review council, post review " +
			"comments and replies. Read the pr-workflow skill for methodology " +
			"once the skill ships.",
		promptSnippet:
			"Use for pull request review and reply work. The shell is in " +
			"place; capabilities land incrementally.",
		parameters: Type.Object({
			action: StringEnum(["load", "status"] as const, {
				description:
					"load: attach a PR to the session. status: report current workflow state.",
			}),
			pr: Type.Optional(
				Type.String({
					description:
						"PR reference: a URL, an owner/repo#number short form, or a " +
						"bare number when run inside a checkout of the target repo. " +
						"Required for action=load.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "status") {
				const ref = state.pr
					? `${state.pr.reference.owner}/${state.pr.reference.repo}#${state.pr.reference.number}`
					: "none";
				const lines = [`active: ${state.active ? "yes" : "no"}`, `pr: ${ref}`];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						active: state.active,
						pr: state.pr,
					},
				};
			}

			// action === "load"
			return {
				content: [
					{
						type: "text",
						text:
							"pr_workflow load is not yet implemented. The extension " +
							"shell is in place; the PR-resolution + council + " +
							"findings pipeline lands in follow-up commits.",
					},
				],
				details: { stub: true, requested: params.pr },
			};
		},
	});
}
