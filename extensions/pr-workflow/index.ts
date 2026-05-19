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

import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { fetchDiff, parseDiff } from "../../lib/internal/github/diff.js";
import { parsePrFileUri, prFileUri, resolvePrFile } from "./buffer.js";
import {
	configureCouncil,
	formatCouncilSummary,
	runCouncilAction,
} from "./council-action.js";
import { formatCritiqueSummary, runCritiqueAction } from "./critique-action.js";
import { fetchFileContent, fetchPrMetadata } from "./fetch.js";
import {
	configureJudge,
	formatJudgeSummary,
	runJudgeAction,
} from "./judge-action.js";
import { loadPr } from "./load.js";
import { runReviewer } from "./reviewer.js";
import { createSpawnRunPi } from "./runpi-spawn.js";
import { createGitHubPrSearch } from "./search.js";
import { buildStack, type StackEntry } from "./stack.js";
import { createPrWorkflowState } from "./state.js";
import {
	type DecideFindingInput,
	decideFinding,
	formatFindingsView,
} from "./synthesis.js";
import { WorktreeRegistry } from "./worktree.js";
import { createGitWorktreeProvider } from "./worktree-git.js";

/**
 * Events used to register `pi://pr/...` URI handling with
 * neovim-pi. The cross-package handshake is event-based
 * because pi loads packages with isolated module roots.
 *
 * The protocol is documented in neovim.pi's
 * `doc/protocol.md` under "Cross-package handler
 * registration". Briefly: emit `register-handler` at init,
 * also subscribe to `ready` and re-emit on receipt. That
 * pair makes the handshake order-independent: whichever
 * side loaded first, the registration eventually lands.
 */
const NEOVIM_PI_REGISTER_HANDLER = "neovim-pi:register-handler";
const NEOVIM_PI_READY = "neovim-pi:ready";

export default function prWorkflow(pi: ExtensionAPI) {
	const state = createPrWorkflowState();

	// Production wiring for the council action. Built
	// lazily on first use so a session that never runs
	// the council never spawns a git provider or touches
	// the state dir.
	let councilDeps: {
		registry: WorktreeRegistry;
		runPi: ReturnType<typeof createSpawnRunPi>;
	} | null = null;
	const getCouncilDeps = () => {
		if (councilDeps !== null) return councilDeps;
		const stateDir = join(
			process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
			"pi",
			"pr-workflow",
		);
		const provider = createGitWorktreeProvider({
			stateDir,
			// The default resolver assumes the user's clone
			// lives at ~/src/github.com/<owner>/<repo>. This
			// matches the convention documented in personal
			// AGENTS.md; a future commit makes it pluggable
			// per workspace.
			resolveSourceRepo: async (req) =>
				join(homedir(), "src", "github.com", req.owner, req.repo),
		});
		councilDeps = {
			registry: new WorktreeRegistry(provider),
			runPi: createSpawnRunPi({ binary: "pi" }),
		};
		return councilDeps;
	};

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
	const registration = {
		method: "buffer.uri.resolve",
		handler,
	};
	// Emit once at init in case neovim-pi loaded first and is
	// already listening.
	pi.events.emit(NEOVIM_PI_REGISTER_HANDLER, registration);
	// Re-emit when neovim-pi reports ready, covering the case
	// where it loaded after we did.
	pi.events.on(NEOVIM_PI_READY, () => {
		pi.events.emit(NEOVIM_PI_REGISTER_HANDLER, registration);
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
			action: StringEnum(
				[
					"load",
					"status",
					"council-config",
					"council",
					"judge-config",
					"judge",
					"critique",
					"findings",
					"decide",
				] as const,
				{
					description:
						"load: attach a PR to the session. " +
						"status: report current workflow state. " +
						"council-config: set the multi-model review roster. " +
						"council: run the configured roster against the loaded PR. " +
						"judge-config: set the judge reviewer for round-2 consolidation. " +
						"judge: run round-2 consolidation against the most recent council run. " +
						"critique: run round-3 critique — the roster pushes back on the judge's consolidated list. " +
						"findings: render the round-4 view (judge + critique + user decisions). " +
						"decide: record the user's verdict on a single finding.",
				},
			),
			pr: Type.Optional(
				Type.String({
					description:
						"PR reference: a URL, an owner/repo#number short form, or a " +
						"bare number when run inside a checkout of the target repo. " +
						"Required for action=load.",
				}),
			),
			reviewers: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({
							description: "Stable reviewer id used in finding origin.",
						}),
						model: Type.Optional(
							Type.String({
								description:
									"Pi --model value (e.g. anthropic:claude-sonnet-4.5).",
							}),
						),
						tools: Type.Optional(
							Type.Array(Type.String(), {
								description:
									"Tool palette passed via --tools (e.g. [read,grep,glob,ls,bash]).",
							}),
						),
					}),
					{
						description:
							"Roster of reviewers. Required for action=council-config.",
					},
				),
			),
			judge: Type.Optional(
				Type.Object({
					id: Type.String({
						description: "Stable id for the judge reviewer.",
					}),
					model: Type.Optional(
						Type.String({
							description:
								"Pi --model value for the judge (e.g. anthropic:claude-opus-4).",
						}),
					),
					tools: Type.Optional(
						Type.Array(Type.String(), {
							description: "Tool palette for the judge.",
						}),
					),
				}),
				{
					description:
						"Judge reviewer config. Required for action=judge-config.",
				},
			),
			findingId: Type.Optional(
				Type.Integer({
					description:
						"Finding id from the most-recent judge run. Required for action=decide.",
				}),
			),
			verdict: Type.Optional(
				StringEnum(
					["endorse", "qualify", "edit", "dismiss", "promote"] as const,
					{
						description:
							"User's verdict on the finding. Required for action=decide.",
					},
				),
			),
			note: Type.Optional(
				Type.String({
					description:
						"Required when verdict=qualify. Says what to soften or qualify.",
				}),
			),
			subject: Type.Optional(
				Type.String({
					description:
						"Used when verdict=edit. Overrides the finding's subject before promotion.",
				}),
			),
			discussion: Type.Optional(
				Type.String({
					description:
						"Used when verdict=edit. Overrides the finding's discussion before promotion.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description:
						"Used when verdict=dismiss. Explains why the finding was dropped.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "council-config") {
				const reviewers = params.reviewers ?? [];
				const result = configureCouncil(state, { reviewers });
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				const names = state.council.roster
					.map((r) => `${r.id}${r.model ? ` (${r.model})` : ""}`)
					.join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Council roster set (${state.council.roster.length}): ${names}`,
						},
					],
					details: { ok: true, roster: state.council.roster },
				};
			}

			if (params.action === "council") {
				const { registry, runPi } = getCouncilDeps();
				const result = await runCouncilAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi }),
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatCouncilSummary(result.run) }],
					details: { ok: true, run: result.run },
				};
			}

			if (params.action === "judge-config") {
				if (!params.judge) {
					return {
						content: [
							{
								type: "text",
								text: "judge-config requires a `judge` argument.",
							},
						],
						details: { ok: false, error: "missing judge argument" },
						isError: true,
					};
				}
				const result = configureJudge(state, { judge: params.judge });
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				const j = state.council.judge;
				return {
					content: [
						{
							type: "text",
							text: `Judge set: ${j?.id}${j?.model ? ` (${j.model})` : ""}`,
						},
					],
					details: { ok: true, judge: state.council.judge },
				};
			}

			if (params.action === "judge") {
				const { registry, runPi } = getCouncilDeps();
				const result = await runJudgeAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi }),
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatJudgeSummary(result.run) }],
					details: { ok: true, run: result.run },
				};
			}

			if (params.action === "critique") {
				const { registry, runPi } = getCouncilDeps();
				const result = await runCritiqueAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi }),
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				const judge = state.council.lastJudge;
				if (judge === null) {
					return {
						content: [
							{
								type: "text",
								text: "Critique ran but judge state vanished.",
							},
						],
						details: { ok: true, run: result.run },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: formatCritiqueSummary({ judge, critique: result.run }),
						},
					],
					details: { ok: true, run: result.run },
				};
			}

			if (params.action === "findings") {
				return {
					content: [{ type: "text", text: formatFindingsView(state) }],
					details: {
						ok: true,
						judgeRunId: state.council.lastJudge?.id ?? null,
						critiqueRunId: state.council.lastCritique?.id ?? null,
						decisionCount: state.council.decisions.size,
					},
				};
			}

			if (params.action === "decide") {
				if (typeof params.findingId !== "number") {
					return {
						content: [
							{
								type: "text",
								text: "decide requires a `findingId` argument.",
							},
						],
						details: { ok: false, error: "missing findingId" },
						isError: true,
					};
				}
				if (!params.verdict) {
					return {
						content: [
							{
								type: "text",
								text: "decide requires a `verdict` argument.",
							},
						],
						details: { ok: false, error: "missing verdict" },
						isError: true,
					};
				}
				const input = buildDecideInput(
					params.findingId,
					params.verdict,
					params.note,
					params.subject,
					params.discussion,
					params.reason,
				);
				const result = decideFinding(state, input);
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Decision recorded for finding ${params.findingId}: ${params.verdict}.`,
						},
					],
					details: { ok: true },
				};
			}

			if (params.action === "status") {
				const ref = state.pr
					? `${state.pr.reference.owner}/${state.pr.reference.repo}#${state.pr.reference.number}`
					: "none";
				const lines = [
					`active: ${state.active ? "yes" : "no"}`,
					`pr: ${ref}`,
					`council roster: ${state.council.roster.length} reviewer(s)`,
					`council last run: ${state.council.lastRun?.id ?? "none"}`,
					`judge: ${state.council.judge?.id ?? "unset"}`,
					`judge last run: ${state.council.lastJudge?.id ?? "none"}`,
					`critique last run: ${state.council.lastCritique?.id ?? "none"}`,
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						active: state.active,
						pr: state.pr,
						council: state.council,
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

function buildDecideInput(
	findingId: number,
	verdict: "endorse" | "qualify" | "edit" | "dismiss" | "promote",
	note: string | undefined,
	subject: string | undefined,
	discussion: string | undefined,
	reason: string | undefined,
): DecideFindingInput {
	switch (verdict) {
		case "endorse":
			return { findingId, verdict: "endorse" };
		case "qualify":
			return { findingId, verdict: "qualify", note: note ?? "" };
		case "edit":
			return { findingId, verdict: "edit", subject, discussion };
		case "dismiss":
			return { findingId, verdict: "dismiss", reason };
		case "promote":
			return { findingId, verdict: "promote" };
	}
}
