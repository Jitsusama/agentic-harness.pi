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
import { fetchPrMetadata } from "./fetch.js";
import { loadPr } from "./load.js";
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
			if (!params.pr) {
				return {
					content: [
						{
							type: "text",
							text: "pr_workflow load requires a `pr` argument.",
						},
					],
					details: { ok: false, error: "missing pr argument" },
					isError: true,
				};
			}

			const outcome = loadPr(state, { input: params.pr });
			if (!outcome.ok) {
				return {
					content: [{ type: "text", text: outcome.error }],
					details: { ok: false, error: outcome.error },
					isError: true,
				};
			}

			const loaded = state.pr;
			if (!loaded) {
				return {
					content: [
						{
							type: "text",
							text: "Unreachable: state.pr null after successful load.",
						},
					],
					details: { ok: false, error: "unreachable" },
					isError: true,
				};
			}

			try {
				loaded.metadata = await fetchPrMetadata(pi, loaded.reference);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Loaded ${loaded.reference.owner}/${loaded.reference.repo}#${loaded.reference.number} but could not fetch metadata: ${message}`,
						},
					],
					details: { ok: false, pr: loaded, error: message },
					isError: true,
				};
			}

			const m = loaded.metadata;
			const summary = m
				? [
						`Loaded ${loaded.reference.owner}/${loaded.reference.repo}#${loaded.reference.number}: ${m.title}`,
						`author: ${m.author} · state: ${m.state}${m.isDraft ? " (draft)" : ""}`,
						`base: ${m.base.ref} ← head: ${m.head.ref}`,
						`${m.changedFiles} files changed, +${m.additions} −${m.deletions}`,
						`${m.url}`,
					].join("\n")
				: "Loaded.";
			return {
				content: [{ type: "text", text: summary }],
				details: { ok: true, pr: loaded },
			};
		},
	});
}
