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
import { fetchDiff, parseDiff } from "../../lib/internal/github/diff.js";
import { parsePrFileUri, prFileUri, resolvePrFile } from "./buffer.js";
import { fetchFileContent, fetchPrMetadata } from "./fetch.js";
import { loadPr } from "./load.js";
import { createGitHubPrSearch } from "./search.js";
import { buildStack, type StackEntry } from "./stack.js";
import { createPrWorkflowState } from "./state.js";

/**
 * Event emitted to ask neovim-pi to install a buffer URI
 * handler. The neovim-pi extension subscribes; if it isn't
 * loaded the emit is a no-op and `pi://pr/...` URIs simply
 * won't open in nvim. The handler signature matches what
 * neovim-pi's `addMethod("buffer.uri.resolve", ...)` expects.
 */
const NEOVIM_PI_REGISTER_HANDLER = "neovim-pi:register-handler";

export default function prWorkflow(pi: ExtensionAPI) {
	const state = createPrWorkflowState();

	// Ask neovim-pi (when present) to route pi://pr/.../file/...
	// URIs through our resolver. The fetcher closes over `pi` so
	// the handler has access to `pi.exec` for the gh round-trip.
	const handler = async (args: unknown[]) => {
		const uri = String(args[0] ?? "");
		const parsed = parsePrFileUri(uri);
		if (parsed === null) {
			return {
				lines: [`pr-workflow: not a pi://pr file URI: ${uri}`],
			};
		}
		return resolvePrFile(parsed, (owner, repo, ref, path) =>
			fetchFileContent(pi, owner, repo, ref, path),
		);
	};
	pi.events.emit(NEOVIM_PI_REGISTER_HANDLER, {
		method: "buffer.uri.resolve",
		handler,
	});

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

			// Diff fetch is best-effort: if it fails, we keep the PR
			// loaded with metadata only and report the failure.
			let diffError: string | null = null;
			try {
				const raw = await fetchDiff(pi, loaded.reference);
				loaded.files = parseDiff(raw);
			} catch (error) {
				diffError = error instanceof Error ? error.message : String(error);
			}

			// Stack discovery is best-effort too. The walker needs
			// metadata's base/head ref names, so we can only run it
			// after the metadata fetch succeeded.
			let stackError: string | null = null;
			try {
				const cursor: StackEntry = {
					reference: loaded.reference,
					title: loaded.metadata.title,
					baseRefName: loaded.metadata.base.ref,
					headRefName: loaded.metadata.head.ref,
				};
				const search = createGitHubPrSearch(
					pi,
					loaded.reference.owner,
					loaded.reference.repo,
				);
				loaded.stack = await buildStack(cursor, search);
			} catch (error) {
				stackError = error instanceof Error ? error.message : String(error);
			}

			const m = loaded.metadata;
			const lines: string[] = [];
			if (m) {
				lines.push(
					`Loaded ${loaded.reference.owner}/${loaded.reference.repo}#${loaded.reference.number}: ${m.title}`,
					`author: ${m.author} · state: ${m.state}${m.isDraft ? " (draft)" : ""}`,
					`base: ${m.base.ref} ← head: ${m.head.ref}`,
					`${m.changedFiles} files changed, +${m.additions} −${m.deletions}`,
					`${m.url}`,
				);
			} else {
				lines.push("Loaded.");
			}
			const stack = loaded.stack;
			if (stack && stack.entries.length > 1) {
				lines.push("");
				lines.push(`Stack (${stack.entries.length} PRs):`);
				stack.entries.forEach((e, i) => {
					const marker = i === stack.cursorIndex ? "▶" : " ";
					lines.push(
						`  ${marker} ${e.reference.owner}/${e.reference.repo}#${e.reference.number}: ${e.title}`,
					);
				});
				if (stack.cursorChildren.length > 0) {
					lines.push(
						`  (fan-out: ${stack.cursorChildren.length} children of cursor)`,
					);
				}
			} else if (stackError) {
				lines.push("");
				lines.push(`Stack discovery failed: ${stackError}`);
			}
			if (loaded.files) {
				lines.push("");
				lines.push("Files:");
				const sha = loaded.metadata?.head.sha;
				for (const f of loaded.files) {
					const tag =
						f.status === "added"
							? "+"
							: f.status === "deleted"
								? "-"
								: f.status === "renamed"
									? "→"
									: "~";
					lines.push(`  ${tag} ${f.path}  (+${f.additions} −${f.deletions})`);
				}
				if (sha) {
					const sample = loaded.files[0];
					if (sample) {
						const uri = prFileUri({
							owner: loaded.reference.owner,
							repo: loaded.reference.repo,
							number: loaded.reference.number,
							sha,
							path: sample.path,
						});
						lines.push("");
						lines.push(
							`To open a file in nvim, call nvim_buffer_open with a URI like:`,
						);
						lines.push(`  ${uri}`);
					}
				}
			} else if (diffError) {
				lines.push("");
				lines.push(`Diff fetch failed: ${diffError}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ok: true, pr: loaded },
			};
		},
	});
}
