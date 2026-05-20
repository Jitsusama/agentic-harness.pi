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
 * stacks, neovim companion) lands in follow-up
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
import { parsePRReference } from "../../lib/internal/github/pr-reference.js";
import { postReview } from "../../lib/internal/github/review-post.js";
import { parsePrFileUri, prFileUri, resolvePrFile } from "./buffer.js";
import {
	configureCouncil,
	formatCouncilSummary,
	retryCouncilReviewer,
	runCouncilAction,
} from "./council-action.js";
import {
	formatCouncilAllSummary,
	runCouncilAllAction,
} from "./council-all-action.js";
import { createCouncilProgressReporter } from "./council-progress-render.js";
import {
	formatCritiqueSummary,
	retryCritiqueReviewer,
	runCritiqueAction,
} from "./critique-action.js";
import { fetchFileContent, fetchPrMetadata } from "./fetch.js";
import { formatCompactFindingsView } from "./findings-view.js";
import {
	formatFixQueueStatus,
	nextFixAction,
	recordFixDoneAction,
	recordFixSkipAction,
} from "./fix-action.js";
import {
	cleanupFixWorktree,
	createFixWorktreeProvisioner,
	listFixWorktrees,
	type ProvisionFixWorktree,
} from "./fix-worktree.js";
import {
	configureJudge,
	formatJudgeSummary,
	runJudgeAction,
} from "./judge-action.js";
import {
	formatJudgeAllSummary,
	runJudgeAllAction,
} from "./judge-all-action.js";
import { persist, restore } from "./lifecycle.js";
import { loadPr } from "./load.js";
import {
	formatLoadSuggestions,
	suggestNextAfterLoad,
} from "./load-trajectory.js";
import {
	type PostReviewExec,
	type PostReviewGate,
	postReviewAction,
	type ReviewEvent,
} from "./post.js";
import { confirmPostGate } from "./post-gate.js";
import {
	formatReviewAllSummary,
	runReviewAllAction,
} from "./review-all-action.js";
import { runReviewer } from "./reviewer.js";
import { createSpawnRunPi } from "./runpi-spawn.js";
import { createGitHubPrSearch } from "./search.js";
import { buildStack, type StackEntry } from "./stack.js";
import {
	configureStackCritic,
	formatStackCriticSummary,
	runStackCriticAction,
} from "./stack-critic-action.js";
import { formatStack, nextInStack, prevInStack } from "./stack-view.js";
import { createPrWorkflowState } from "./state.js";
import { clearPrStatusLine, refreshPrStatusLine } from "./status-line.js";
import { formatPrSummary } from "./summary.js";
import {
	type DecideFindingInput,
	decideFinding,
	formatFindingsView,
} from "./synthesis.js";
import { confirmReplyGate, confirmResolveGate } from "./thread-gate.js";
import { fetchReviewThreads, replyToThread, resolveThread } from "./threads.js";
import {
	formatThreadsView,
	loadThreadsAction,
	replyToThreadAction,
	resolveThreadAction,
} from "./threads-action.js";
import { summarizeUsage, type UsageBreakdown } from "./usage.js";
import { resolveVerifyExtensionPath } from "./verify-path.js";
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
		extraExtensions: readonly string[];
	} | null = null;
	const prWorkflowStateDir = () =>
		join(
			process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
			"pi",
			"pr-workflow",
		);
	// The default resolver assumes the user's clone
	// lives at ~/src/github.com/<owner>/<repo>. This
	// matches the convention documented in personal
	// AGENTS.md; a future commit makes it pluggable
	// per workspace.
	const resolveSourceRepo = async (req: { owner: string; repo: string }) =>
		join(homedir(), "src", "github.com", req.owner, req.repo);

	const getCouncilDeps = () => {
		if (councilDeps !== null) return councilDeps;
		const provider = createGitWorktreeProvider({
			stateDir: prWorkflowStateDir(),
			resolveSourceRepo,
		});
		councilDeps = {
			registry: new WorktreeRegistry(provider),
			runPi: createSpawnRunPi({ binary: "pi" }),
			// Every reviewer subagent loads pr-workflow-verify
			// so it can self-check its JSON output via the
			// verify_output tool before ending the run.
			extraExtensions: [resolveVerifyExtensionPath()],
		};
		return councilDeps;
	};

	// Fix worktrees: separate from council worktrees
	// because the fix loop needs the branch checked out
	// (commits, push) while council needs the SHA
	// detached (read-only research). Built lazily so a
	// session that never enters the fix loop never
	// touches the state dir.
	let fixProvision: ProvisionFixWorktree | null = null;
	const getFixProvision = (): ProvisionFixWorktree => {
		if (fixProvision !== null) return fixProvision;
		fixProvision = createFixWorktreeProvisioner({
			stateDir: prWorkflowStateDir(),
			resolveSourceRepo,
		});
		return fixProvision;
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
					"council-all",
					"judge-config",
					"judge-all",
					"review-all",
					"judge",
					"critique",
					"findings",
					"decide",
					"post",
					"stack",
					"stack-next",
					"stack-prev",
					"council-retry",
					"critique-retry",
					"stack-critic-config",
					"stack-critic",
					"threads",
					"reply",
					"resolve",
					"fix-next",
					"fix-done",
					"fix-skip",
					"fix-worktree-list",
					"fix-worktree-cleanup",
					"summary",
				] as const,
				{
					description:
						"load: attach a PR to the session. " +
						"status: report current workflow state. " +
						"council-config: set the multi-model review roster. " +
						"council: run the configured roster against the loaded PR. " +
						"council-all: fan the configured roster out across every PR " +
						"in the loaded stack concurrently (Phase A of the stack-wide " +
						"redesign). Cursor PR's run lands in council.lastRun; the rest " +
						"stash under stackRuns and rehydrate on stack-next / stack-prev. " +
						"judge-config: set the judge reviewer for round-2 consolidation. " +
						"judge: run round-2 consolidation against the most recent council run. " +
						"judge-all: run the configured judge across every stack PR that " +
						"has a council run. review-all: run council-all, then judge-all. " +
						"critique: run round-3 critique — the roster pushes back on the judge's consolidated list. " +
						"findings: render the round-4 view (judge + critique + user decisions). " +
						"decide: record the user's verdict on a single finding. " +
						"post: send eligible findings to GitHub as a PR review. " +
						"stack: render the discovered PR stack with cursor highlighted. " +
						"stack-next: re-load the next PR downstream of the cursor. " +
						"stack-prev: re-load the PR upstream of the cursor. " +
						"council-retry: re-run one reviewer in the most recent " +
						"council run and substitute their output in place. " +
						"critique-retry: re-run one reviewer in the most recent " +
						"critique run and substitute their output in place. " +
						"stack-critic-config: set the reviewer that runs the " +
						"cross-PR stack-critic. " +
						"stack-critic: synthesize cross-PR findings across every " +
						"PR in the discovered stack. " +
						"threads: fetch the loaded PR's existing review threads. " +
						"reply: post a reply to a thread by its [T#] index. " +
						"resolve: resolve a thread by its [T#] index. " +
						"fix-next: return the next finding queued for fix " +
						"(verdict=fix) with no recorded outcome. Includes a " +
						"fix worktree path the agent must `cd` into before " +
						"editing and committing, so the user's primary " +
						"checkout stays untouched. The agent applies the " +
						"edit in its main loop using normal tools so the " +
						"user can interrupt at any point. " +
						"fix-done: record a commit against a queued fix. " +
						"Requires findingId and commitSha. " +
						"fix-skip: abandon a queued fix with a reason. " +
						"Requires findingId and skipReason. " +
						"fix-worktree-list: enumerate fix worktrees that " +
						"have accumulated under the pr-workflow state dir. " +
						"Read-only; no arguments. " +
						"fix-worktree-cleanup: remove the fix worktree " +
						"for a PR. Requires `pr` (owner/repo#number form " +
						"or bare number when run inside a checkout). " +
						"Pass force:true to delete uncommitted edits. " +
						"summary: one-shot read-only view of the loaded PR " +
						"(header, stack, threads, council, fix queue). " +
						"Reads cached snapshots only — never fetches.",
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
									"Pi --model value: either a bare model id (claude-opus-4-7) or provider/model (anthropic/claude-opus-4-7). Slashes only; pi reads colons as a thinking-level separator.",
							}),
						),
						thinkingLevel: Type.Optional(
							StringEnum(["off", "low", "medium", "high"] as const, {
								description:
									"Pi --thinking value. Omit to inherit pi's session default.",
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
				Type.Object(
					{
						id: Type.String({
							description: "Stable id for the judge reviewer.",
						}),
						model: Type.Optional(
							Type.String({
								description:
									"Pi --model value for the judge (e.g. anthropic/claude-opus-4-7).",
							}),
						),
						thinkingLevel: Type.Optional(
							StringEnum(["off", "low", "medium", "high"] as const, {
								description:
									"Pi --thinking value for the judge. Omit to inherit pi's session default.",
							}),
						),
						tools: Type.Optional(
							Type.Array(Type.String(), {
								description: "Tool palette for the judge.",
							}),
						),
					},
					{
						description:
							"Judge reviewer config. Required for action=judge-config.",
					},
				),
			),
			stackCritic: Type.Optional(
				Type.Object(
					{
						id: Type.String({
							description: "Stable id for the stack-critic reviewer.",
						}),
						model: Type.Optional(
							Type.String({
								description:
									"Pi --model value for the stack critic (e.g. anthropic/claude-opus-4-7).",
							}),
						),
						thinkingLevel: Type.Optional(
							StringEnum(["off", "low", "medium", "high"] as const, {
								description:
									"Pi --thinking value for the stack critic. Omit to inherit pi's session default.",
							}),
						),
						tools: Type.Optional(
							Type.Array(Type.String(), {
								description: "Tool palette for the stack critic.",
							}),
						),
					},
					{
						description:
							"Stack-critic reviewer config. Required for action=stack-critic-config.",
					},
				),
			),
			scope: Type.Optional(
				StringEnum(["pr", "stack"] as const, {
					description:
						"Which set of findings the decide action targets. 'pr' (default) hits the per-PR judge findings; 'stack' hits the stack-critic findings.",
				}),
			),
			findingId: Type.Optional(
				Type.Integer({
					description:
						"Finding id from the most-recent judge run. Required for action=decide.",
				}),
			),
			reviewerId: Type.Optional(
				Type.String({
					description:
						"Reviewer id from the active council roster. Required for action=council-retry.",
				}),
			),
			verdict: Type.Optional(
				StringEnum(
					["endorse", "qualify", "edit", "dismiss", "promote", "fix"] as const,
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
			event: Type.Optional(
				StringEnum(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const, {
					description:
						"Review event sent to GitHub when action=post. Defaults to COMMENT.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description:
						"Optional caller-supplied summary prefix prepended to the auto-generated review body.",
				}),
			),
			instructions: Type.Optional(
				Type.String({
					description:
						"Used when verdict=fix. Optional free-form note describing how the user (or the main agent, on the user's behalf) plans to fix the finding. Persisted with the decision; not sent anywhere.",
				}),
			),
			threadIndex: Type.Optional(
				Type.Integer({
					description:
						"1-based index of a review thread in the most recent threads snapshot (the [T#] label rendered by action=threads). Required for action=reply and action=resolve.",
				}),
			),
			replyBody: Type.Optional(
				Type.String({
					description:
						"The reply body to post to the targeted thread. Required for action=reply.",
				}),
			),
			commitSha: Type.Optional(
				Type.String({
					description:
						"Git commit sha that landed the fix. Required for action=fix-done.",
				}),
			),
			skipReason: Type.Optional(
				Type.String({
					description:
						"Reason the queued fix is being abandoned. Required for action=fix-skip; surfaced in the findings view.",
				}),
			),
			verbose: Type.Optional(
				Type.Boolean({
					description:
						"For action=findings: when true, render the full wall-of-text view (one paragraph per finding with discussion, critiques and original-versus-edited text). When omitted or false, render the compact one-row-per-finding index.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For action=fix-worktree-cleanup: when true, fall back to rm -rf after `git worktree remove` refuses (uncommitted edits, stale admin state). Default false leaves a blocked worktree in place and surfaces a hint.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const progress = createCouncilProgressReporter(ctx);
				const result = await runCouncilAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
					progress,
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

			if (params.action === "council-all") {
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await runCouncilAllAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
					fetchers: {
						metadata: (reference) => fetchPrMetadata(pi, reference),
						diff: async (reference) => {
							const raw = await fetchDiff(pi, reference);
							return parseDiff(raw);
						},
					},
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [
						{ type: "text", text: formatCouncilAllSummary(result.run) },
					],
					details: { ok: true, run: result.run },
				};
			}

			if (params.action === "council-retry") {
				if (!params.reviewerId) {
					return {
						content: [
							{
								type: "text",
								text: "council-retry requires a `reviewerId` argument.",
							},
						],
						details: { ok: false, error: "missing reviewerId argument" },
						isError: true,
					};
				}
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await retryCouncilReviewer({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
					reviewerId: params.reviewerId,
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
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await runJudgeAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
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

			if (params.action === "judge-all") {
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await runJudgeAllAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
					fetchers: {
						metadata: (reference) => fetchPrMetadata(pi, reference),
					},
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatJudgeAllSummary(result.run) }],
					details: { ok: true, run: result.run },
				};
			}

			if (params.action === "review-all") {
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await runReviewAllAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
					fetchers: {
						metadata: (reference) => fetchPrMetadata(pi, reference),
						diff: async (reference) => {
							const raw = await fetchDiff(pi, reference);
							return parseDiff(raw);
						},
					},
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatReviewAllSummary(result.run) }],
					details: { ok: true, run: result.run },
				};
			}

			if (params.action === "critique") {
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await runCritiqueAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
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

			if (params.action === "critique-retry") {
				if (!params.reviewerId) {
					return {
						content: [
							{
								type: "text",
								text: "critique-retry requires a `reviewerId` argument.",
							},
						],
						details: { ok: false, error: "missing reviewerId argument" },
						isError: true,
					};
				}
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await retryCritiqueReviewer({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
					reviewerId: params.reviewerId,
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
								text: "Critique retry succeeded but judge state vanished.",
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

			if (params.action === "stack-critic-config") {
				if (!params.stackCritic) {
					return {
						content: [
							{
								type: "text",
								text: "stack-critic-config requires a `stackCritic` argument.",
							},
						],
						details: { ok: false, error: "missing stackCritic argument" },
						isError: true,
					};
				}
				const result = configureStackCritic(state, {
					stackCritic: params.stackCritic,
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				const sc = state.council.stackCritic;
				return {
					content: [
						{
							type: "text",
							text: `Stack critic set: ${sc?.id}${sc?.model ? ` (${sc.model})` : ""}`,
						},
					],
					details: { ok: true, stackCritic: state.council.stackCritic },
				};
			}

			if (params.action === "stack-critic") {
				const { registry, runPi, extraExtensions } = getCouncilDeps();
				const result = await runStackCriticAction({
					state,
					registry,
					dispatch: (opts) => runReviewer({ ...opts, runPi, extraExtensions }),
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [
						{ type: "text", text: formatStackCriticSummary(result.run) },
					],
					details: { ok: true, run: result.run },
				};
			}

			if (params.action === "findings") {
				const text = params.verbose
					? formatFindingsView(state)
					: formatCompactFindingsView(state);
				return {
					content: [{ type: "text", text }],
					details: {
						ok: true,
						judgeRunId: state.council.lastJudge?.id ?? null,
						critiqueRunId: state.council.lastCritique?.id ?? null,
						stackCriticRunId: state.stackCritic?.id ?? null,
						decisionCount: state.council.decisions.size,
						stackDecisionCount: state.stackDecisions.size,
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
					params.instructions,
					params.scope,
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

			if (params.action === "post") {
				const event: ReviewEvent = params.event ?? "COMMENT";
				const exec: PostReviewExec = async ({
					ref,
					event: ev,
					body,
					comments,
				}) => {
					await postReview(pi, ref, ev, body, comments);
				};
				const gate: PostReviewGate = (summary) => confirmPostGate(ctx, summary);
				const result = await postReviewAction({
					state,
					event,
					body: params.body,
					exec,
					gate,
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				const skippedSummary =
					result.payload.skipped.length === 0
						? ""
						: ` (${result.payload.skipped.length} skipped)`;
				return {
					content: [
						{
							type: "text",
							text: `Review posted as ${event}: ${result.payload.includedFindingIds.length} finding(s)${skippedSummary}.`,
						},
					],
					details: { ok: true, payload: result.payload },
				};
			}

			if (params.action === "stack") {
				if (state.pr === null) {
					return {
						content: [
							{ type: "text", text: "No PR loaded; call action=load first." },
						],
						details: { ok: false, error: "no pr loaded" },
						isError: true,
					};
				}
				if (state.pr.stack === null || state.pr.stack.entries.length <= 1) {
					return {
						content: [
							{
								type: "text",
								text: "This PR is not part of a detected stack (no upstream or downstream PRs were found).",
							},
						],
						details: { ok: true, stack: null },
					};
				}
				return {
					content: [{ type: "text", text: formatStack(state.pr.stack) }],
					details: { ok: true, stack: state.pr.stack },
				};
			}

			if (params.action === "stack-next" || params.action === "stack-prev") {
				if (state.pr === null || state.pr.stack === null) {
					return {
						content: [
							{
								type: "text",
								text: "No stack discovered; call action=load on a PR that's part of a stack.",
							},
						],
						details: { ok: false, error: "no stack" },
						isError: true,
					};
				}
				const pick =
					params.action === "stack-next"
						? nextInStack(state.pr.stack)
						: prevInStack(state.pr.stack);
				if (pick === null) {
					const direction =
						params.action === "stack-next" ? "downstream" : "upstream";
					const suffix =
						params.action === "stack-next" &&
						state.pr.stack.cursorChildren.length > 0
							? ` Cursor has ${state.pr.stack.cursorChildren.length} fan-out children; ask the user which one to load.`
							: "";
					return {
						content: [
							{
								type: "text",
								text: `No ${direction} PR in stack from cursor.${suffix}`,
							},
						],
						details: { ok: false, error: `no ${direction}` },
					};
				}
				const ref = `${pick.reference.owner}/${pick.reference.repo}#${pick.reference.number}`;
				return {
					content: [
						{
							type: "text",
							text: `Next in stack: ${ref} (${pick.title}). Call action=load with pr="${ref}" to navigate.`,
						},
					],
					details: { ok: true, target: pick, suggestedAction: "load" },
				};
			}

			if (params.action === "threads") {
				const result = await loadThreadsAction({
					state,
					fetcher: (ref) => fetchReviewThreads(pi, ref),
				});
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatThreadsView(state) }],
					details: {
						ok: true,
						prNumber: result.snapshot.prNumber,
						threadCount: result.snapshot.threads.length,
						fetchedAt: result.snapshot.fetchedAt,
					},
				};
			}

			if (params.action === "reply") {
				if (typeof params.threadIndex !== "number") {
					return {
						content: [
							{
								type: "text",
								text: "reply requires a `threadIndex` argument.",
							},
						],
						details: { ok: false, error: "missing threadIndex" },
						isError: true,
					};
				}
				if (typeof params.replyBody !== "string") {
					return {
						content: [
							{
								type: "text",
								text: "reply requires a `replyBody` argument.",
							},
						],
						details: { ok: false, error: "missing replyBody" },
						isError: true,
					};
				}
				const threadForGate = state.threads?.threads[params.threadIndex - 1];
				if (threadForGate === undefined) {
					const result = await replyToThreadAction({
						state,
						index: params.threadIndex,
						body: params.replyBody,
						sender: (threadId, body) => replyToThread(pi, threadId, body),
					});
					return {
						content: [
							{
								type: "text",
								text: result.ok ? "Reply posted." : result.error,
							},
						],
						details: result.ok
							? { ok: true, url: result.url }
							: { ok: false, error: result.error },
						isError: !result.ok,
					};
				}
				const gate = await confirmReplyGate(
					ctx,
					threadForGate,
					params.replyBody,
				);
				if (!gate.approved) {
					return {
						content: [{ type: "text", text: gate.reason }],
						details: { ok: false, error: gate.reason },
						isError: true,
					};
				}
				const result = await replyToThreadAction({
					state,
					index: params.threadIndex,
					body: gate.body,
					sender: (threadId, body) => replyToThread(pi, threadId, body),
				});
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
							text: `Reply posted to [T${params.threadIndex}]: ${result.url}`,
						},
					],
					details: {
						ok: true,
						url: result.url,
						threadIndex: params.threadIndex,
						body: gate.body,
					},
				};
			}

			if (params.action === "resolve") {
				if (typeof params.threadIndex !== "number") {
					return {
						content: [
							{
								type: "text",
								text: "resolve requires a `threadIndex` argument.",
							},
						],
						details: { ok: false, error: "missing threadIndex" },
						isError: true,
					};
				}
				const threadForGate = state.threads?.threads[params.threadIndex - 1];
				if (threadForGate !== undefined) {
					const gate = await confirmResolveGate(ctx, threadForGate);
					if (!gate.approved) {
						return {
							content: [{ type: "text", text: gate.reason }],
							details: { ok: false, error: gate.reason },
							isError: true,
						};
					}
				}
				const result = await resolveThreadAction({
					state,
					index: params.threadIndex,
					resolver: (threadId) => resolveThread(pi, threadId),
				});
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
							text: `Thread [T${params.threadIndex}] resolved.`,
						},
					],
					details: {
						ok: true,
						isResolved: result.isResolved,
						threadIndex: params.threadIndex,
					},
				};
			}

			if (params.action === "fix-next") {
				const result = await nextFixAction(state, getFixProvision());
				if (!result.ok) {
					return {
						content: [{ type: "text", text: result.error }],
						details: { ok: false, error: result.error },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: result.summary }],
					details: {
						ok: true,
						context: result.context,
						worktree: result.worktree,
						done: result.context === null,
					},
				};
			}

			if (params.action === "fix-done") {
				if (typeof params.findingId !== "number") {
					return {
						content: [
							{
								type: "text",
								text: "fix-done requires a `findingId` argument.",
							},
						],
						details: { ok: false, error: "missing findingId" },
						isError: true,
					};
				}
				if (typeof params.commitSha !== "string") {
					return {
						content: [
							{
								type: "text",
								text: "fix-done requires a `commitSha` argument.",
							},
						],
						details: { ok: false, error: "missing commitSha" },
						isError: true,
					};
				}
				const result = recordFixDoneAction({
					state,
					findingId: params.findingId,
					commitSha: params.commitSha,
				});
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
							text: `Finding ${params.findingId} recorded as fixed in ${params.commitSha.trim()}.`,
						},
					],
					details: {
						ok: true,
						findingId: params.findingId,
						commitSha: params.commitSha.trim(),
					},
				};
			}

			if (params.action === "fix-skip") {
				if (typeof params.findingId !== "number") {
					return {
						content: [
							{
								type: "text",
								text: "fix-skip requires a `findingId` argument.",
							},
						],
						details: { ok: false, error: "missing findingId" },
						isError: true,
					};
				}
				if (typeof params.skipReason !== "string") {
					return {
						content: [
							{
								type: "text",
								text: "fix-skip requires a `skipReason` argument.",
							},
						],
						details: { ok: false, error: "missing skipReason" },
						isError: true,
					};
				}
				const result = recordFixSkipAction({
					state,
					findingId: params.findingId,
					reason: params.skipReason,
				});
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
							text: `Finding ${params.findingId} marked as skipped.`,
						},
					],
					details: {
						ok: true,
						findingId: params.findingId,
						reason: params.skipReason.trim(),
					},
				};
			}

			if (params.action === "fix-worktree-list") {
				const entries = await listFixWorktrees(prWorkflowStateDir());
				if (entries.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No fix worktrees on disk.",
							},
						],
						details: { ok: true, entries: [] },
					};
				}
				const lines = [
					`${entries.length} fix worktree${entries.length === 1 ? "" : "s"} on disk:`,
					"",
				];
				for (const entry of entries) {
					const ref = `${entry.owner}/${entry.repo}#${entry.number}`;
					const when =
						entry.mtimeMs === null
							? "mtime unknown"
							: `mtime ${new Date(entry.mtimeMs).toISOString()}`;
					lines.push(`  ${ref}  (${when})`);
					lines.push(`    ${entry.path}`);
				}
				lines.push("");
				lines.push(
					"Call action=fix-worktree-cleanup pr=<ref> to remove one. Pass force:true to drop uncommitted edits.",
				);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { ok: true, entries },
				};
			}

			if (params.action === "fix-worktree-cleanup") {
				if (!params.pr) {
					return {
						content: [
							{
								type: "text",
								text: "fix-worktree-cleanup requires a `pr` argument (owner/repo#number or a bare number inside a checkout).",
							},
						],
						details: { ok: false, error: "missing pr argument" },
						isError: true,
					};
				}
				const loadedRef = state.pr?.reference;
				const reference = parsePRReference(
					params.pr,
					loadedRef?.owner,
					loadedRef?.repo,
				);
				if (reference === null) {
					const error =
						`Could not parse "${params.pr}" as a PR reference. ` +
						"Expected a full URL, a short form (owner/repo#N), or a bare " +
						"number with a PR already loaded so owner/repo can be inferred.";
					return {
						content: [{ type: "text", text: error }],
						details: { ok: false, error },
						isError: true,
					};
				}
				const outcome = await cleanupFixWorktree({
					stateDir: prWorkflowStateDir(),
					owner: reference.owner,
					repo: reference.repo,
					number: reference.number,
					force: params.force === true,
				});
				if (outcome.status === "missing") {
					return {
						content: [
							{
								type: "text",
								text: `No fix worktree at ${outcome.path}; nothing to remove.`,
							},
						],
						details: { ok: true, outcome },
					};
				}
				if (outcome.status === "blocked") {
					return {
						content: [
							{
								type: "text",
								text: `Refused: ${outcome.reason}\n${outcome.hint}`,
							},
						],
						details: { ok: false, outcome },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Removed ${outcome.path} (${outcome.method}).`,
						},
					],
					details: { ok: true, outcome },
				};
			}

			if (params.action === "summary") {
				const text = formatPrSummary(state);
				return {
					content: [{ type: "text", text }],
					details: { ok: true },
				};
			}

			if (params.action === "status") {
				const ref = state.pr
					? `${state.pr.reference.owner}/${state.pr.reference.repo}#${state.pr.reference.number}`
					: "none";
				const breakdown = summarizeUsage({
					council: state.council.lastRun,
					judge: state.council.lastJudge,
					critique: state.council.lastCritique,
				});
				const stackSnapshotSummary =
					state.stackRuns.size === 0
						? "none"
						: Array.from(state.stackRuns.keys())
								.sort((a, b) => a - b)
								.map((n) => `#${n}`)
								.join(", ");
				const lines = [
					`active: ${state.active ? "yes" : "no"}`,
					`pr: ${ref}`,
					`council roster: ${state.council.roster.length} reviewer(s)`,
					`council last run: ${state.council.lastRun?.id ?? "none"}`,
					`judge: ${state.council.judge?.id ?? "unset"}`,
					`judge last run: ${state.council.lastJudge?.id ?? "none"}`,
					`critique last run: ${state.council.lastCritique?.id ?? "none"}`,
					`stack critic: ${state.council.stackCritic?.id ?? "unset"}`,
					`stack critic last run: ${state.stackCritic?.id ?? "none"}`,
					`stack findings: ${state.stackCritic?.findings.length ?? 0} (${state.stackDecisions.size} decided)`,
					`stack snapshots: ${stackSnapshotSummary}`,
					`threads: ${state.threads === null ? "not fetched" : `${state.threads.threads.length} (fetched ${state.threads.fetchedAt})`}`,
					formatFixQueueStatus(state),
					...renderUsageLines(breakdown),
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						active: state.active,
						pr: state.pr,
						council: state.council,
						usage: breakdown,
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
			const suggestedNext = suggestNextAfterLoad(state);
			for (const line of formatLoadSuggestions(suggestedNext)) {
				lines.push(line);
			}
			// Persist is fired centrally by the `tool_result`
			// handler at the bottom of this file — see there
			// for why we don't sprinkle persist() calls per
			// action.
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ok: true, pr: loaded, suggestedNext },
			};
		},
	});

	// Restore the persisted config slice on every session
	// start: this is what makes `/reload` non-destructive
	// for the user's roster, judge and stack-critic
	// configuration. See lifecycle.ts for what is and
	// isn't persisted.
	pi.on("session_start", async (_event, ctx) => {
		restore(state, pi, ctx);
		refreshPrStatusLine(ctx, state);
	});

	// Push the latest overview line after every tool call,
	// and re-persist the state slice while we're here. The
	// status-line refresh is what motivated the hook (PR
	// #198); persistence joins it because pr-workflow
	// actions are the only thing that mutate the state
	// either surface cares about, so a per-tool fire is
	// both necessary and sufficient. Pi sequences event
	// handlers, so a tool that mutates state in-handler
	// has finished writing by the time we read it here.
	pi.on("tool_result", async (_event, ctx) => {
		refreshPrStatusLine(ctx, state);
		persist(state, pi);
	});

	pi.on("agent_end", async (_event, ctx) => {
		refreshPrStatusLine(ctx, state);
	});
}

// `clearPrStatusLine` is exported for symmetry; pi tears
// down the status bar on session exit, so the extension
// never needs to call it explicitly today.
void clearPrStatusLine;

/**
 * Format the cost summary lines for the status panel.
 * Returns an empty list when no usage was recorded so the
 * panel doesn't show a `usage: ...` line for a fresh
 * session.
 */
function renderUsageLines(breakdown: UsageBreakdown): string[] {
	if (breakdown.total === undefined) return [];
	const lines: string[] = [];
	lines.push("");
	lines.push("usage:");
	const stages: Array<[string, typeof breakdown.council]> = [
		["council", breakdown.council],
		["judge", breakdown.judge],
		["critique", breakdown.critique],
	];
	for (const [name, usage] of stages) {
		if (usage === undefined) continue;
		lines.push(`  ${name}: ${formatUsage(usage)}`);
	}
	lines.push(`  total: ${formatUsage(breakdown.total)}`);
	return lines;
}

function formatUsage(usage: NonNullable<UsageBreakdown["total"]>): string {
	const tokens = usage.tokens.total.toLocaleString("en-CA");
	const cost = usage.cost.total.toFixed(4);
	return `${tokens} tokens, $${cost}`;
}

function buildDecideInput(
	findingId: number,
	verdict: "endorse" | "qualify" | "edit" | "dismiss" | "promote" | "fix",
	note: string | undefined,
	subject: string | undefined,
	discussion: string | undefined,
	reason: string | undefined,
	instructions: string | undefined,
	scope: "pr" | "stack" | undefined,
): DecideFindingInput {
	switch (verdict) {
		case "endorse":
			return { findingId, verdict: "endorse", scope };
		case "qualify":
			return { findingId, verdict: "qualify", note: note ?? "", scope };
		case "edit":
			return { findingId, verdict: "edit", subject, discussion, scope };
		case "dismiss":
			return { findingId, verdict: "dismiss", reason, scope };
		case "promote":
			return { findingId, verdict: "promote", scope };
		case "fix":
			return { findingId, verdict: "fix", instructions, scope };
	}
}
