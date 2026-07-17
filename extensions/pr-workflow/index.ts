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
import { createMutex } from "../../lib/internal/async-mutex.js";
import { sessionGateDeps } from "../../lib/internal/gate/session-deps.js";
import { fetchDiff, parseDiff } from "../../lib/internal/github/diff.js";
import { parsePRReference } from "../../lib/internal/github/pr-reference.js";
import { getCurrentRepo } from "../../lib/internal/github/repo-discovery.js";
import { postReview } from "../../lib/internal/github/review-post.js";
import { packageStateDir } from "../../lib/internal/package-state-dir.js";
import { findOrCreateSidequestForPr } from "../../lib/internal/quest/pr-sidequest.js";
import { getQuestPrBridge } from "../../lib/quest/pr-bridge.js";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.js";
import { resolveParentPiInstall } from "../../lib/subagent/install.js";
import { recoverReviewerRuns } from "../../lib/subagent/recovery.js";
import { createSupervisorRunPi } from "../../lib/subagent/runpi/supervisor.js";
import {
	type CouncilReviewer,
	runReviewer,
} from "../../lib/subagent/subagent.js";
import { parsePrFileUri, prFileUri, resolvePrFile } from "./buffer.js";
import {
	createCancellableDispatch,
	formatCancellationOutcome,
	ReviewerCancellationRegistry,
	type ReviewOperation,
} from "./cancellation.js";
import {
	loadPrWorkflowConfig,
	type PrWorkflowReviewerEntry,
	parseReviewer,
} from "./config.js";
import type { CouncilDispatch } from "./council.js";
import {
	configureCouncil,
	formatCouncilSummary,
	retryCouncilReviewer,
	runCouncilAction,
} from "./council-action.js";
import type { CouncilProgress } from "./council-progress.js";
import { createCouncilProgressReporter } from "./council-progress-render.js";
import {
	formatCritiqueSummary,
	retryCritiqueReviewer,
	runCritiqueAction,
} from "./critique-action.js";
import { decideBatchAction } from "./decide-action.js";
import { fetchFileContent, fetchPrHeadSha, fetchPrMetadata } from "./fetch.js";
import type { ConventionalLabel } from "./findings.js";
import { formatCompactFindingsView } from "./findings-view.js";
import {
	formatFixQueueStatus,
	nextFixAction,
	recordFixDoneAction,
	recordFixSkipAction,
} from "./fix-action.js";
import {
	createGitFixWorktreeProvider,
	FixWorktreeProviderBroker,
	isFixWorktreeProvider,
	PR_WORKFLOW_REGISTER_FIX_WORKTREE_PROVIDER,
} from "./fix-worktree.js";
import {
	configureJudge,
	formatJudgeSummary,
	runJudgeAction,
} from "./judge-action.js";
import { resolveJudgeCharter } from "./judge-charter.js";
import { persist, restore } from "./lifecycle.js";
import { loadPr } from "./load.js";
import {
	formatLoadSuggestions,
	suggestNextAfterLoad,
} from "./load-trajectory.js";
import { addManualFindingAction } from "./manual-finding-action.js";
import { hasFindingsForParticipant } from "./participant-identities.js";
import {
	addPersona,
	editPersona,
	formatPersonaList,
	type PersonaWrite,
	removePersona,
} from "./persona-action.js";
import { loadPersonas, personasDir } from "./personas.js";
import {
	buildReviewPayload,
	type PostReviewExec,
	type PostReviewGate,
	postReviewAction,
	type ReviewEvent,
	type ReviewPayload,
	renderSummary,
} from "./post.js";
import { confirmPostGate } from "./post-gate.js";
import { buildReviewProseGate } from "./prose-gate.js";
import { logQuestJourneyForPr, recordReviewRound } from "./quest-bridge.js";
import { ResultsStore } from "./results-store.js";
import {
	isReviewContextProvider,
	PR_WORKFLOW_REGISTER_REVIEW_CONTEXT_PROVIDER,
	ReviewContextProviderBroker,
} from "./review-context.js";
import { reviewValidationDirective } from "./review-directive.js";
import { createGitHubPrSearch } from "./search.js";
import { buildStack, type StackEntry } from "./stack.js";
import {
	formatStackReviewActionSummary,
	runStackReviewAction,
} from "./stack-review-action.js";
import { formatStack, nextInStack, prevInStack } from "./stack-view.js";
import { createPrWorkflowState, resetPrWorkflowSession } from "./state.js";
import { clearPrStatusLine, refreshPrStatusLine } from "./status-line.js";
import { formatPrSummary } from "./summary.js";
import {
	type DecideFindingInput,
	decideFinding,
	formatFindingsView,
} from "./synthesis.js";
import {
	auditThreadsAction,
	formatThreadAudit,
} from "./thread-audit-action.js";
import {
	confirmReplyAndResolveGate,
	confirmReplyGate,
	confirmResolveGate,
	confirmResolveManyGate,
} from "./thread-gate.js";
import { describeReplyOutcome } from "./thread-reply-outcome.js";
import { fetchReviewThreads, replyToThread, resolveThread } from "./threads.js";
import {
	captureThreadExpectation,
	formatThreadsView,
	loadThreadsAction,
	replyToThreadAction,
	resolveThreadAction,
	resolveThreadsAction,
} from "./threads-action.js";
import { summarizeUsage, type UsageBreakdown } from "./usage.js";
import { resolveVerifyPack } from "./verify-packs.js";
import {
	isWorktreeProvider,
	PR_WORKFLOW_READY,
	PR_WORKFLOW_REGISTER_WORKTREE_PROVIDER,
	WorktreeProviderBroker,
	WorktreeRegistry,
} from "./worktree.js";
import { createGitWorktreeProvider } from "./worktree-git.js";
import { reclaimWorktrees } from "./worktree-reclaim.js";
import { selectWorktreeBySha } from "./worktree-select.js";

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

/**
 * Results-store retention. A run body is pruned on activation
 * only when it is both beyond the newest this-many files and
 * older than this age, so a recent, possibly still-referenced
 * body is always kept while long-stale surplus is reclaimed. The
 * caps are generous: the bound is meant to stop unbounded
 * accumulation across sessions, not to run tight.
 */
const RESULTS_RETAIN_FILES = 500;
const RESULTS_RETAIN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Raw reviewer run directories (events, stderr, per-reviewer
// result files) are bulkier than the distilled result bodies
// and only needed while a run is live or under recovery, so
// they age out on a shorter window and a tighter count.
const REVIEWER_RUNS_RETAIN = 100;
const REVIEWER_RUNS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Upper bound on waiting for cancelled review runs to drain before
// reclaiming worktrees. Cancellation aborts the subprocesses, so a
// drain is normally near-instant; this only bounds a reviewer that
// ignores its abort, so teardown and the quick-mutation lane cannot
// hang on it forever.
const RECLAIM_DRAIN_TIMEOUT_MS = 30 * 1000;

/**
 * Load the persona library from disk and return a synchronous
 * resolver from persona id to charter prose. The council action
 * needs a sync resolver (it maps the roster inline), so the
 * filesystem read happens once here, up front, per run. A bad
 * persona file is skipped, not fatal: the load returns its error
 * list, which the caller surfaces as a warning while the rest of
 * the roster proceeds.
 */
async function loadCharterResolver(): Promise<{
	resolve: (personaId: string) => string | undefined;
	/** Persona identity (name + description) by id, for judge exhibits. */
	meta: (
		personaId: string,
	) => { name: string; description: string } | undefined;
	errors: readonly { id: string; error: string }[];
}> {
	const { personas, errors } = await loadPersonas(personasDir());
	const byId = new Map(personas.map((p) => [p.id, p]));
	return {
		resolve: (id) => byId.get(id)?.charter,
		meta: (id) => {
			const persona = byId.get(id);
			return persona
				? { name: persona.name, description: persona.description }
				: undefined;
		},
		errors,
	};
}

/**
 * Validate that a persona-add/persona-edit call carries the four
 * fields a persona needs (id, name, description, charter), all
 * non-empty, and assemble them into a {@link PersonaWrite}. On a
 * missing field it returns an error naming what is absent; on
 * success it returns the assembled write, narrowed to defined
 * strings.
 */
function requirePersonaWrite(params: {
	persona?: string;
	name?: string;
	description?: string;
	charter?: string;
}): { ok: true; write: PersonaWrite } | { ok: false; error: string } {
	const filled = (value: string | undefined): value is string =>
		value !== undefined && value.trim() !== "";
	const { persona, name, description, charter } = params;
	const missing: string[] = [];
	if (!filled(persona)) missing.push("persona (id)");
	if (!filled(name)) missing.push("name");
	if (!filled(description)) missing.push("description");
	if (!filled(charter)) missing.push("charter");
	if (
		!filled(persona) ||
		!filled(name) ||
		!filled(description) ||
		!filled(charter)
	) {
		return {
			ok: false,
			error: `Persona write requires: ${missing.join(", ")}.`,
		};
	}
	return { ok: true, write: { id: persona, name, description, charter } };
}

export default function prWorkflow(pi: ExtensionAPI) {
	const state = createPrWorkflowState();
	const prWorkflowStateDir = () => packageStateDir("pr-workflow");
	const reviewerArtifacts = () =>
		new ReviewerArtifactsStore(prWorkflowStateDir());
	// Heavy run bodies (council, judge, critique transcripts) live
	// in this store keyed by run id; the session log keeps only the
	// id pointers. See lifecycle.ts for the persist/restore split.
	const resultsStore = new ResultsStore(prWorkflowStateDir());
	// Bound the results directory on activation. Run ids are unique
	// per run, so superseded bodies linger unreferenced; this prunes
	// the old surplus while keeping every recent body a live
	// snapshot might still point at. Best-effort: a sweep failure
	// must never block activation.
	try {
		resultsStore.cleanup({
			maxFiles: RESULTS_RETAIN_FILES,
			maxAgeMs: RESULTS_RETAIN_MAX_AGE_MS,
		});
	} catch {
		// Retention is advisory; ignore a transient sweep failure.
	}
	// Prune old terminal reviewer run directories too, so the raw
	// artifacts they hold do not accumulate unbounded. Only
	// terminal runs are removed, so an in-flight or recoverable
	// run is never touched.
	void reviewerArtifacts()
		.cleanupTerminalRuns({
			maxRuns: REVIEWER_RUNS_RETAIN,
			maxAgeMs: REVIEWER_RUNS_MAX_AGE_MS,
		})
		.catch(() => {
			// Retention is advisory; ignore a transient sweep failure.
		});
	void recoverReviewerRuns(reviewerArtifacts()).then(
		(summary) => {
			state.reviewerRecovery = summary;
		},
		(error) => {
			state.reviewerRecovery = {
				completed: [],
				active: [],
				stale: [],
				warnings: [
					`Reviewer recovery failed: ${error instanceof Error ? error.message : String(error)}`,
				],
			};
		},
	);

	// Production wiring for the council action. Built
	// lazily on first use so a session that never runs
	// the council never spawns a git provider or touches
	// the state dir.
	let councilDeps: {
		registry: WorktreeRegistry;
		runPi: ReturnType<typeof createSupervisorRunPi>;
	} | null = null;
	// The default resolver assumes the user's clone
	// lives at ~/src/github.com/<owner>/<repo>. This
	// matches the convention documented in personal
	// AGENTS.md. Proprietary/private packages can
	// register a higher-priority provider over the event
	// bridge without this public package knowing their
	// workspace rules.
	const resolveSourceRepo = async (req: { owner: string; repo: string }) =>
		join(homedir(), "src", "github.com", req.owner, req.repo);
	const cancellations = new ReviewerCancellationRegistry();

	// Pi runs sibling tool calls from one assistant message
	// concurrently. The quick-mutation actions each read shared
	// session state, await a gate or a network round-trip, then
	// write it back; serializing them through one FIFO mutex
	// makes them atomic against each other without perceptible
	// latency (they finish in milliseconds, or wait on a gate
	// the user is already looking at). Read-only actions and the
	// long-running council-class runs deliberately stay outside
	// the lane: reads are consistent under single-threaded JS,
	// and runs pin to their PR + reserve ids so they're safe to
	// overlap anything.
	const actionMutex = createMutex();
	const QUICK_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
		"decide",
		"add-finding",
		"reply",
		"resolve",
		"post",
		"fix-next",
		"fix-done",
		"fix-skip",
		"load",
		"reset",
	]);
	const worktreeProviders = new WorktreeProviderBroker(
		createGitWorktreeProvider({
			stateDir: prWorkflowStateDir(),
			resolveSourceRepo,
		}),
	);
	const fixWorktreeProviders = new FixWorktreeProviderBroker(
		createGitFixWorktreeProvider({
			stateDir: prWorkflowStateDir(),
			resolveSourceRepo,
		}),
	);
	const reviewContextProviders = new ReviewContextProviderBroker();
	const registerWorktreeProvider = (provider: unknown): void => {
		if (!isWorktreeProvider(provider)) return;
		worktreeProviders.register(provider);
	};
	const registerFixWorktreeProvider = (provider: unknown): void => {
		if (!isFixWorktreeProvider(provider)) return;
		fixWorktreeProviders.register(provider);
	};
	const registerReviewContextProvider = (provider: unknown): void => {
		if (!isReviewContextProvider(provider)) return;
		reviewContextProviders.register(provider);
	};
	const prWorkflowApi = {
		registerWorktreeProvider,
		listWorktreeProviders: () => worktreeProviders.providerIds(),
		registerFixWorktreeProvider,
		listFixWorktreeProviders: () => fixWorktreeProviders.providerIds(),
		registerReviewContextProvider,
		listReviewContextProviders: () => reviewContextProviders.providerIds(),
	};
	pi.events.on(
		PR_WORKFLOW_REGISTER_WORKTREE_PROVIDER,
		registerWorktreeProvider,
	);
	pi.events.on(
		PR_WORKFLOW_REGISTER_FIX_WORKTREE_PROVIDER,
		registerFixWorktreeProvider,
	);
	pi.events.on(
		PR_WORKFLOW_REGISTER_REVIEW_CONTEXT_PROVIDER,
		registerReviewContextProvider,
	);
	pi.events.emit(PR_WORKFLOW_READY, prWorkflowApi);

	const getCouncilDeps = () => {
		if (councilDeps !== null) return councilDeps;
		councilDeps = {
			registry: new WorktreeRegistry(worktreeProviders),
			runPi: createSupervisorRunPi({
				piInstall: resolveParentPiInstall(),
				stateDir: prWorkflowStateDir(),
			}),
		};
		return councilDeps;
	};
	// Reclaim the session's review worktrees, draining any
	// in-flight run first. A no-op when no council ran (the
	// registry is built lazily), so it is cheap to call on
	// every reset, PR switch and shutdown. Best-effort:
	// `reclaimWorktrees` collects release failures instead of
	// throwing, and we never let teardown reject.
	const reclaimSessionWorktrees = async () => {
		if (councilDeps === null) return { released: 0, errors: [] };
		return reclaimWorktrees(councilDeps.registry, cancellations, {
			drainTimeoutMs: RECLAIM_DRAIN_TIMEOUT_MS,
		});
	};
	const progressControls = () => ({
		cancelReviewer: (reviewerId: string) =>
			formatCancellationOutcome(cancellations.cancel(reviewerId)),
		cancelAll: () => formatCancellationOutcome(cancellations.cancel()),
	});
	const runWithCancellableReviewers = async <T>(
		operation: ReviewOperation,
		run: (deps: {
			readonly registry: WorktreeRegistry;
			readonly dispatch: CouncilDispatch;
		}) => Promise<T>,
		progress?: CouncilProgress,
	): Promise<T> => {
		const { registry, runPi } = getCouncilDeps();
		const activeRun = cancellations.beginRun(operation);
		const dispatch = createCancellableDispatch(activeRun, (opts) => {
			// Each stage gets its own verify pack: a sibling
			// extension that registers the stage-specific
			// `verify_output` tool plus a skill that teaches
			// the contract. Setting requiresVerification when
			// (and only when) a pack is loaded keeps
			// enforcement tied to the extension+skill that
			// makes verification possible.
			const pack = resolveVerifyPack(opts.expectedVerificationStage);
			return runReviewer({
				...opts,
				runPi,
				extraExtensions: pack ? [pack.extensionPath] : undefined,
				extraSkills: pack?.skillPath ? [pack.skillPath] : undefined,
				requiresVerification: pack !== undefined,
			});
		});
		try {
			return await run({ registry, dispatch });
		} finally {
			activeRun.end();
			// Backstop the panel teardown to the same finally as the
			// registry cleanup, so the panel can never outlive the
			// registered run even if a run function forgets to finish
			// it. finish() is idempotent, so the run's own finish and
			// this one don't double up.
			try {
				progress?.finish();
			} catch {
				// A broken reporter must not mask the run's outcome or
				// throw from finally; teardown is best-effort here.
			}
		}
	};

	// Fix worktrees: separate from council worktrees
	// because the fix loop needs the branch checked out
	// (commits, push) while council needs the SHA
	// detached (read-only research).

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
					"reset",
					"status",
					"council-config",
					"council",
					"judge-config",
					"review",
					"judge",
					"critique",
					"findings",
					"add-finding",
					"decide",
					"preview-post",
					"post",
					"stack",
					"stack-next",
					"stack-prev",
					"council-retry",
					"critique-retry",
					"threads",
					"reply",
					"resolve",
					"fix-next",
					"fix-done",
					"fix-skip",
					"fix-worktree-list",
					"fix-worktree-cleanup",
					"worktree-list",
					"worktree-cleanup",
					"release-identity-lock",
					"summary",
					"personas",
					"persona-add",
					"persona-edit",
					"persona-remove",
					"audit-threads",
				] as const,
				{
					description:
						"load: attach a PR to the session. " +
						"reset: clear the active PR, runs, decisions and status line while keeping reviewer config. " +
						"status: report current workflow state. " +
						"council-config: set the multi-model review roster; omit reviewers to use config-file defaults. " +
						"council: run the configured roster against the loaded PR. " +
						"judge-config: set the judge reviewer for round-2 consolidation; omit judge to use config-file defaults. " +
						"judge: run round-2 consolidation against the most recent council run. " +
						"review: run the stack-wide context review pipeline " +
						"(one stack-aware council fan-out plus one stack-aware judge). " +
						"critique: run round-3 critique — the roster pushes back on the judge's consolidated list. " +
						"findings: render the round-4 view (judge + critique + user decisions). " +
						"add-finding: add a user-authored finding to the current PR findings list. " +
						"preview-post: dry-run the post payload — returns the same " +
						"review body + inline comments + skipped findings that `post` " +
						"would build, without firing the gate or contacting GitHub. " +
						"Use to preview which findings will degrade to body before posting. " +
						"decide: record the user's verdict on a single finding (findingId), " +
						"or on many at once by passing findingIds with one batchable verdict " +
						"(endorse, dismiss, promote, fix, qualify). " +
						"post: send eligible findings to GitHub as a PR review. " +
						"stack: render the discovered PR stack with cursor highlighted. " +
						"stack-next: re-load the next PR downstream of the cursor. " +
						"stack-prev: re-load the PR upstream of the cursor. " +
						"council-retry: re-run one reviewer in the most recent " +
						"council run and substitute their output in place. " +
						"critique-retry: re-run one reviewer in the most recent " +
						"critique run and substitute their output in place. " +
						"threads: fetch the loaded PR's existing review threads. " +
						"reply: post a reply to a thread by its [T#] index; pass " +
						"resolve=true to reply and resolve in one combined gate. " +
						"resolve: resolve a thread by its [T#] index, or many at once with threadIndices behind one gate. " +
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
						"worktree-list: enumerate review worktrees on disk " +
						"(the per-SHA trees council reviews materialize). " +
						"Read-only; no arguments. Use it to find crash " +
						"orphans a hard kill left behind, which the " +
						"shutdown, reset and PR-switch release edges could " +
						"not reclaim. " +
						"worktree-cleanup: remove a review worktree by `sha` " +
						"(the value worktree-list prints; a prefix is " +
						"enough). The provider force-removes, since a review " +
						"tree is a read-only checkout of the PR head. " +
						"release-identity-lock: drop a participant id from " +
						"the lock map so council-config or judge-config can " +
						"re-use it with a different model. Old findings keep " +
						"their attribution string but reference the freed id; " +
						"use only when you accept that audit ambiguity. " +
						"summary: one-shot read-only view of the loaded PR " +
						"(header, stack, threads, council, fix queue). " +
						"Reads cached snapshots only — never fetches. " +
						"personas: list the persona library (id, name, description). " +
						"persona-add: create a new persona file from persona (id), " +
						"name, description and charter; refuses to overwrite. " +
						"persona-edit: rewrite an existing persona in place; same " +
						"fields; refuses if it does not exist. " +
						"persona-remove: delete the persona named by persona (id). " +
						"audit-threads: stack-aware advisory audit of inbound review " +
						"threads — for each unresolved thread, judge whether the PR " +
						"diff or another PR in the stack already addresses it. Never " +
						"posts; informs the user's reply. Uses the configured judge " +
						"as the auditor.",
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
			sha: Type.Optional(
				Type.String({
					description:
						"Review worktree sha to reclaim. Required for " +
						"action=worktree-cleanup; a prefix of the value " +
						"worktree-list prints is enough.",
				}),
			),
			reviewers: Type.Optional(
				Type.Array(
					Type.Object({
						persona: Type.Optional(
							Type.String({
								description:
									"Persona id (a file stem in the personas dir) whose " +
									"charter becomes this reviewer's standing system prompt. " +
									"The reviewer id defaults to the persona id; set an " +
									"explicit id to run the same persona at two mechanism settings.",
							}),
						),
						id: Type.Optional(
							Type.String({
								description:
									"Stable reviewer id used in finding origin. Defaults to " +
									"the persona id when a persona is given; required when it is not.",
							}),
						),
						model: Type.Optional(
							Type.String({
								description:
									"Pi --model value: either a bare model id (claude-opus-4-7) or provider/model (anthropic/claude-opus-4-7). Slashes only; pi reads colons as a thinking-level separator.",
							}),
						),
						thinkingLevel: Type.Optional(
							StringEnum(
								["off", "minimal", "low", "medium", "high", "xhigh"] as const,
								{
									description:
										"Pi --thinking value. Omit to inherit pi's session default.",
								},
							),
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
							"Roster of reviewers. For action=council-config, omit to load reviewers from the pr-workflow config file.",
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
							StringEnum(
								["off", "minimal", "low", "medium", "high", "xhigh"] as const,
								{
									description:
										"Pi --thinking value for the judge. Omit to inherit pi's session default.",
								},
							),
						),
						tools: Type.Optional(
							Type.Array(Type.String(), {
								description: "Tool palette for the judge.",
							}),
						),
					},
					{
						description:
							"Judge reviewer config. For action=judge-config, omit to load the judge from the pr-workflow config file.",
					},
				),
			),
			persona: Type.Optional(
				Type.String({
					description:
						"Persona id (the file-name stem). Required for persona-add, " +
						"persona-edit and persona-remove.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"Persona display name (frontmatter). Required for persona-add and persona-edit.",
				}),
			),
			description: Type.Optional(
				Type.String({
					description:
						"Event description, or — for persona-add/persona-edit — the persona's one-line description (frontmatter).",
				}),
			),
			charter: Type.Optional(
				Type.String({
					description:
						"Persona charter prose (the file body): the lens only, no " +
						"output-contract scaffolding. Required for persona-add and persona-edit.",
				}),
			),
			intent: Type.Optional(
				Type.String({
					description:
						"Per-run focus for a council, judge or critique run — " +
						"e.g. 'look hardest at the auth changes' or 'be stricter " +
						"this pass'. Merged into the run's prompt addendum. The " +
						"standing lens lives in each reviewer's persona charter; " +
						"this is the per-run poke and does not persist.",
				}),
			),
			scope: Type.Optional(
				StringEnum(["pr", "stack"] as const, {
					description:
						"Which set of findings the decide action targets. 'pr' (default) hits the per-PR judge findings; 'stack' hits cross-PR findings from action=review.",
				}),
			),
			label: Type.Optional(
				StringEnum(
					[
						"praise",
						"nitpick",
						"suggestion",
						"issue",
						"todo",
						"question",
						"thought",
						"chore",
						"note",
					] as const,
					{
						description:
							"Conventional Comments label. Required for action=add-finding; also accepted on verdict=edit to reclassify a finding (e.g. demote `issue` to `nitpick`).",
					},
				),
			),
			decorations: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Conventional Comments decorations, e.g. blocking or non-blocking. Used by action=add-finding, and by action=decide verdict=edit to override a finding's decorations in place (pass an empty list to clear them, for example to flip a blocking finding to non-blocking).",
				}),
			),
			severity: Type.Optional(
				StringEnum(["critical", "medium", "minor"] as const, {
					description: "Optional severity bucket for action=add-finding.",
				}),
			),
			confidence: Type.Optional(
				Type.Number({
					description:
						"Optional confidence score from 0 to 1 for action=add-finding.",
				}),
			),
			file: Type.Optional(
				Type.String({
					description:
						"File path. For action=add-finding: with start/end becomes an inline finding, without them becomes a file-level finding. For action=decide verdict=edit: swaps the finding's file (with start/end becomes a line finding on the new file; without them drops to a file-kind location).",
				}),
			),
			start: Type.Optional(
				Type.Integer({
					description:
						"Start line. For action=add-finding: inline comment start. For action=decide verdict=edit: overrides the finding's line range (file is inherited from the original when not also supplied).",
				}),
			),
			end: Type.Optional(
				Type.Integer({
					description:
						"End line. Defaults to `start`. Used by action=add-finding and action=decide verdict=edit.",
				}),
			),
			side: Type.Optional(
				StringEnum(["old", "new", "both"] as const, {
					description:
						"Diff side. Defaults to `new`. Used by action=add-finding and action=decide verdict=edit; only meaningful on line-kind findings.",
				}),
			),
			originNote: Type.Optional(
				Type.String({
					description:
						"Optional private note stored on the user-origin finding for action=add-finding.",
				}),
			),
			findingId: Type.Optional(
				Type.Integer({
					description:
						"Finding id from the most-recent judge run. Required for action=decide (single). Omit when passing findingIds for a batch decide.",
				}),
			),
			findingIds: Type.Optional(
				Type.Array(Type.Integer(), {
					description:
						"Finding ids for a batch action=decide: apply one verdict to every id in the list. Only the override-free verdicts are batchable (endorse, dismiss, promote, fix, qualify); edit stays a single-finding decide via findingId. Shared note/reason/instructions apply to the whole batch.",
				}),
			),
			reviewerId: Type.Optional(
				Type.String({
					description:
						"Reviewer id from the active council roster. Required for action=council-retry, action=critique-retry and action=release-identity-lock.",
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
						"Used by action=add-finding, and by verdict=edit to override the finding's subject before promotion. With verdict=edit, may be combined with `discussion`, `label`, `decorations` and/or location overrides (`file`, `start`, `end`, `side`); at least one must be provided.",
				}),
			),
			discussion: Type.Optional(
				Type.String({
					description:
						"Used by action=add-finding, and by verdict=edit to override the finding's discussion before promotion. With verdict=edit, may be combined with `subject`, `label`, `decorations` and/or location overrides; at least one must be provided.",
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
						"1-based index of a review thread in the most recent threads snapshot (the [T#] label rendered by action=threads). Required for action=reply, and for action=resolve unless threadIndices is given.",
				}),
			),
			threadIndices: Type.Optional(
				Type.Array(Type.Integer(), {
					description:
						"1-based thread indices for a batch action=resolve: resolve every listed thread behind one gate. Review-level comments in the list are reported as failed, not resolved.",
				}),
			),
			replyBody: Type.Optional(
				Type.String({
					description:
						"The reply body to post to the targeted thread. Required for action=reply.",
				}),
			),
			resolve: Type.Optional(
				Type.Boolean({
					description:
						"For action=reply: when true, resolve the thread in the same " +
						"step as the reply, behind a single combined gate. Defaults " +
						"to false (reply only). Use this to avoid the two-gate dance " +
						"when you reply and immediately close a thread.",
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
						"For action=findings: when true, render the full wall-of-text view (one paragraph per finding with discussion, critiques and original-versus-edited text). When omitted or false, render the compact one-row-per-finding index. For action=preview-post: when true, also render the actual review body markdown and per-comment inline payload that `post` would send.",
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
			// The action body, closing over the typed `params` and `ctx`
			// from this execute call. The explicit return type mirrors
			// what the handlers produce (text content plus the optional
			// `isError` flag pi tolerates) so the `type: "text"` literals
			// stay narrowed without an annotation that rejects `isError`.
			const handleAction = async (): Promise<{
				content: { type: "text"; text: string }[];
				details: unknown;
				isError?: boolean;
			}> => {
				if (params.action === "council-config") {
					let reviewers: readonly PrWorkflowReviewerEntry[] | undefined;
					if (params.reviewers !== undefined) {
						// Normalize tool-supplied reviewers through the same
						// parser the config file uses, so persona-only entries
						// get their id derived and both paths validate alike.
						const normalized: PrWorkflowReviewerEntry[] = [];
						for (let i = 0; i < params.reviewers.length; i += 1) {
							const parsed = parseReviewer(
								params.reviewers[i],
								`reviewers[${i}]`,
							);
							if (!parsed.ok) {
								return {
									content: [{ type: "text", text: parsed.error }],
									details: { ok: false, error: parsed.error },
									isError: true,
								};
							}
							normalized.push(parsed.reviewer);
						}
						reviewers = normalized;
					}
					let sourcePath: string | null = null;
					if (reviewers === undefined) {
						const loaded = await loadPrWorkflowConfig();
						if (!loaded.ok) {
							const error =
								`${loaded.error}\n` +
								"Pass `reviewers` explicitly or create a config file with a top-level `reviewers` array.";
							return {
								content: [{ type: "text", text: error }],
								details: { ok: false, error, configPath: loaded.path },
								isError: true,
							};
						}
						if (loaded.config.defaults.reviewers === undefined) {
							const error = `No reviewers found in pr-workflow config at ${loaded.config.path}.`;
							return {
								content: [{ type: "text", text: error }],
								details: { ok: false, error, configPath: loaded.config.path },
								isError: true,
							};
						}
						reviewers = [...loaded.config.defaults.reviewers];
						sourcePath = loaded.config.path;
					}
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
					const source = sourcePath ? ` from ${sourcePath}` : "";
					return {
						content: [
							{
								type: "text",
								text: `Council roster set${source} (${state.council.roster.length}): ${names}`,
							},
						],
						details: {
							ok: true,
							roster: state.council.roster,
							...(sourcePath ? { configPath: sourcePath } : {}),
						},
					};
				}

				if (params.action === "council") {
					const progress = createCouncilProgressReporter(
						ctx,
						progressControls(),
					);
					const charters = await loadCharterResolver();
					for (const e of charters.errors) {
						ctx.ui.notify(`Persona "${e.id}" skipped: ${e.error}`, "warning");
					}
					const result = await runWithCancellableReviewers(
						"council",
						({ registry, dispatch }) =>
							runCouncilAction({
								state,
								registry,
								dispatch,
								reviewContexts: reviewContextProviders,
								fetchThreads: (ref) => fetchReviewThreads(pi, ref),
								resolveCharter: charters.resolve,
								...(params.intent ? { intent: params.intent } : {}),
								progress,
							}),
						progress,
					);
					if (!result.ok) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { ok: false, error: result.error },
							isError: true,
						};
					}
					if (state.pr) {
						const findingsCount = result.run.reviewerOutputs.reduce(
							(sum, r) => sum + r.findings.length,
							0,
						);
						logQuestJourneyForPr(
							state.pr.reference,
							`Council ran with ${result.run.reviewerOutputs.length} reviewers; gathered ${findingsCount} findings.`,
						);
					}
					{
						const warningSuffix =
							result.warnings && result.warnings.length > 0
								? `\n\n${result.warnings.join("\n")}`
								: "";
						return {
							content: [
								{
									type: "text",
									text: `${formatCouncilSummary(result.run)}${warningSuffix}`,
								},
							],
							details: { ok: true, run: result.run },
						};
					}
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
					const reviewerId = params.reviewerId;
					const charters = await loadCharterResolver();
					for (const e of charters.errors) {
						ctx.ui.notify(`Persona "${e.id}" skipped: ${e.error}`, "warning");
					}
					const progress = createCouncilProgressReporter(
						ctx,
						progressControls(),
					);
					const result = await runWithCancellableReviewers(
						"council-retry",
						({ registry, dispatch }) =>
							retryCouncilReviewer({
								state,
								registry,
								dispatch,
								reviewContexts: reviewContextProviders,
								fetchThreads: (ref) => fetchReviewThreads(pi, ref),
								resolveCharter: charters.resolve,
								...(params.intent ? { intent: params.intent } : {}),
								reviewerId,
								progress,
							}),
						progress,
					);
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
					let judge: CouncilReviewer | undefined = params.judge;
					let sourcePath: string | null = null;
					if (judge === undefined) {
						const loaded = await loadPrWorkflowConfig();
						if (!loaded.ok) {
							const error =
								`${loaded.error}\n` +
								"Pass `judge` explicitly or create a config file with a top-level `judge` object.";
							return {
								content: [{ type: "text", text: error }],
								details: { ok: false, error, configPath: loaded.path },
								isError: true,
							};
						}
						if (loaded.config.defaults.judge === undefined) {
							const error = `No judge found in pr-workflow config at ${loaded.config.path}.`;
							return {
								content: [{ type: "text", text: error }],
								details: { ok: false, error, configPath: loaded.config.path },
								isError: true,
							};
						}
						judge = loaded.config.defaults.judge;
						sourcePath = loaded.config.path;
					}
					const result = configureJudge(state, { judge });
					if (!result.ok) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { ok: false, error: result.error },
							isError: true,
						};
					}
					const j = state.council.judge;
					const source = sourcePath ? ` from ${sourcePath}` : "";
					return {
						content: [
							{
								type: "text",
								text: `Judge set${source}: ${j?.id}${j?.model ? ` (${j.model})` : ""}`,
							},
						],
						details: {
							ok: true,
							judge: state.council.judge,
							...(sourcePath ? { configPath: sourcePath } : {}),
						},
					};
				}

				if (params.action === "judge") {
					const progress = createCouncilProgressReporter(
						ctx,
						progressControls(),
						{
							statusLabel: "judge",
							title: "PR Judge Progress",
						},
					);
					const judgeCharter = await resolveJudgeCharter(personasDir());
					const judgeCharters = await loadCharterResolver();
					const personaExhibits = state.council.roster.flatMap((reviewer) => {
						if (reviewer.persona === undefined) return [];
						const meta = judgeCharters.meta(reviewer.persona);
						return meta
							? [
									{
										reviewerId: reviewer.id,
										name: meta.name,
										description: meta.description,
									},
								]
							: [];
					});
					const result = await runWithCancellableReviewers(
						"judge",
						({ registry, dispatch }) =>
							runJudgeAction({
								state,
								registry,
								dispatch,
								reviewContexts: reviewContextProviders,
								fetchThreads: (ref) => fetchReviewThreads(pi, ref),
								judgeCharter,
								...(personaExhibits.length > 0 ? { personaExhibits } : {}),
								...(params.intent ? { intent: params.intent } : {}),
								progress,
							}),
						progress,
					);
					if (!result.ok) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { ok: false, error: result.error },
							isError: true,
						};
					}
					if (state.pr) {
						const rawFindingsCount =
							state.council.lastRun?.reviewerOutputs.reduce(
								(sum, r) => sum + r.findings.length,
								0,
							) ?? 0;
						const councilReviewerIds =
							state.council.lastRun?.reviewerOutputs.map((r) => r.reviewerId) ??
							[];
						const doc = recordReviewRound(state.pr.reference, {
							councilReviewerIds,
							rawFindingsCount,
							judgeRun: result.run,
							critiqueRun: state.council.lastCritique,
						});
						const journey = doc
							? `Judge consolidated to ${result.run.consolidatedFindings.length} findings; round ${doc.roundNumber} ${doc.isNew ? "scaffolded as" : "appended to"} ${doc.docId}.`
							: `Judge consolidated to ${result.run.consolidatedFindings.length} findings.`;
						logQuestJourneyForPr(state.pr.reference, journey);
					}
					{
						const warningPrefix =
							result.warnings && result.warnings.length > 0
								? `${result.warnings.join("\n")}

`
								: "";
						return {
							content: [
								{
									type: "text",
									text: `${warningPrefix}${formatJudgeSummary(result.run)}

${reviewValidationDirective()}`,
								},
							],
							details: { ok: true, run: result.run },
						};
					}
				}

				if (params.action === "review") {
					const progress = createCouncilProgressReporter(
						ctx,
						progressControls(),
						{
							statusLabel: "review",
							title: "PR Stack Review Progress",
						},
					);
					const stackJudgeCharter = await resolveJudgeCharter(personasDir());
					const result = await runWithCancellableReviewers(
						"review",
						({ registry, dispatch }) =>
							runStackReviewAction({
								state,
								registry,
								dispatch,
								reviewContexts: reviewContextProviders,
								fetchThreads: (ref) => fetchReviewThreads(pi, ref),
								progress,
								judgeCharter: stackJudgeCharter,
								fetchers: {
									metadata: (reference) => fetchPrMetadata(pi, reference),
									diff: async (reference) => {
										const raw = await fetchDiff(pi, reference);
										return parseDiff(raw);
									},
								},
							}),
						progress,
					);
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
								text: `${formatStackReviewActionSummary(result.run)}

${reviewValidationDirective()}`,
							},
						],
						details: { ok: true, run: result.run },
					};
				}

				if (params.action === "critique") {
					const progress = createCouncilProgressReporter(
						ctx,
						progressControls(),
						{
							statusLabel: "critique",
							title: "PR Critique Progress",
						},
					);
					const critiqueCharters = await loadCharterResolver();
					for (const e of critiqueCharters.errors) {
						ctx.ui.notify(`Persona "${e.id}" skipped: ${e.error}`, "warning");
					}
					const result = await runWithCancellableReviewers(
						"critique",
						({ registry, dispatch }) =>
							runCritiqueAction({
								state,
								registry,
								dispatch,
								reviewContexts: reviewContextProviders,
								fetchThreads: (ref) => fetchReviewThreads(pi, ref),
								resolveCharter: critiqueCharters.resolve,
								...(params.intent ? { intent: params.intent } : {}),
								progress,
							}),
						progress,
					);
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
								text: formatCritiqueSummary({
									judge: result.judge,
									critique: result.run,
								}),
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
					const reviewerId = params.reviewerId;
					const critiqueCharters = await loadCharterResolver();
					for (const e of critiqueCharters.errors) {
						ctx.ui.notify(`Persona "${e.id}" skipped: ${e.error}`, "warning");
					}
					const progress = createCouncilProgressReporter(
						ctx,
						progressControls(),
					);
					const result = await runWithCancellableReviewers(
						"critique-retry",
						({ registry, dispatch }) =>
							retryCritiqueReviewer({
								state,
								registry,
								dispatch,
								reviewContexts: reviewContextProviders,
								fetchThreads: (ref) => fetchReviewThreads(pi, ref),
								resolveCharter: critiqueCharters.resolve,
								...(params.intent ? { intent: params.intent } : {}),
								reviewerId,
								progress,
							}),
						progress,
					);
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
								text: formatCritiqueSummary({
									judge: result.judge,
									critique: result.run,
								}),
							},
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
							stackFindingRunId: state.stackFindingRun?.id ?? null,
							decisionCount: state.council.decisions.size,
							stackDecisionCount: state.stackDecisions.size,
						},
					};
				}

				if (params.action === "add-finding") {
					if (!params.label) {
						return {
							content: [
								{
									type: "text",
									text: "add-finding requires a `label` argument.",
								},
							],
							details: { ok: false, error: "missing label" },
							isError: true,
						};
					}
					if (!params.subject) {
						return {
							content: [
								{
									type: "text",
									text: "add-finding requires a `subject` argument.",
								},
							],
							details: { ok: false, error: "missing subject" },
							isError: true,
						};
					}
					if (!params.discussion) {
						return {
							content: [
								{
									type: "text",
									text: "add-finding requires a `discussion` argument.",
								},
							],
							details: { ok: false, error: "missing discussion" },
							isError: true,
						};
					}
					const result = addManualFindingAction({
						state,
						label: params.label,
						subject: params.subject,
						discussion: params.discussion,
						decorations: params.decorations,
						severity: params.severity,
						confidence: params.confidence,
						file: params.file,
						start: params.start,
						end: params.end,
						side: params.side,
						originNote: params.originNote,
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
								text:
									`Manual finding ${result.finding.id} added. ` +
									`Run action=decide findingId=${result.finding.id} verdict=endorse to include it when posting.`,
							},
						],
						details: { ok: true, finding: result.finding },
					};
				}

				if (params.action === "decide") {
					if (params.findingIds && params.findingIds.length > 0) {
						const batch = decideBatchAction(state, {
							findingIds: [...new Set(params.findingIds)],
							verdict: params.verdict,
							scope: params.scope,
							note: params.note,
							reason: params.reason,
							instructions: params.instructions,
						});
						return {
							content: [{ type: "text", text: batch.summary }],
							details: batch.details,
							...(batch.isError ? { isError: true } : {}),
						};
					}
					if (typeof params.findingId !== "number") {
						return {
							content: [
								{
									type: "text",
									text: "decide requires a `findingId` argument (or `findingIds` for a batch).",
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
					const input = buildDecideInput({
						findingId: params.findingId,
						verdict: params.verdict,
						note: params.note,
						subject: params.subject,
						discussion: params.discussion,
						reason: params.reason,
						instructions: params.instructions,
						scope: params.scope,
						label: params.label,
						decorations: params.decorations,
						file: params.file,
						start: params.start,
						end: params.end,
						side: params.side,
					});
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

				if (params.action === "preview-post") {
					if (state.pr === null) {
						return {
							content: [
								{ type: "text", text: "No PR loaded; call action=load first." },
							],
							details: { ok: false, error: "no pr loaded" },
							isError: true,
						};
					}
					const payload = buildReviewPayload(state);
					const diffLoaded = (state.pr?.files?.length ?? 0) > 0;
					const event: ReviewEvent = params.event ?? "COMMENT";
					const wrappedBody = renderSummary(state, payload, params.body, event);
					const text = params.verbose
						? formatPreviewPostVerbose(payload, diffLoaded, wrappedBody)
						: formatPreviewPostSummary(payload, diffLoaded);
					return {
						content: [{ type: "text", text }],
						details: { ok: true, payload, diffLoaded },
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
					const gate: PostReviewGate = (summary) =>
						confirmPostGate(ctx, summary);
					const result = await postReviewAction({
						state,
						event,
						body: params.body,
						exec,
						gate,
						proseGate: buildReviewProseGate(sessionGateDeps(ctx, pi)),
						currentHead: (ref) => fetchPrHeadSha(pi, ref),
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
					const warningSuffix =
						result.warnings && result.warnings.length > 0
							? `\n\n${result.warnings.join("\n")}`
							: "";
					return {
						content: [
							{
								type: "text",
								text: `Review posted as ${event}: ${result.payload.includedFindingIds.length} finding(s)${skippedSummary}.${warningSuffix}`,
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
					const directionLabel =
						params.action === "stack-next" ? "Downstream PR" : "Upstream PR";
					return {
						content: [
							{
								type: "text",
								text: `${directionLabel}: ${ref} (${pick.title}). Call action=load with pr="${ref}" to navigate.`,
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
					const alsoResolve = params.resolve === true;
					const threadForGate = state.threads?.threads[params.threadIndex - 1];
					// Capture the targeted thread's identity and the snapshot
					// version before the gate await, so a concurrent refetch or
					// sibling mutation during the gate can't redirect the reply
					// to a different thread.
					const replyExpectation = captureThreadExpectation(
						state,
						params.threadIndex,
					);
					let replyBodyToPost = params.replyBody;
					if (threadForGate !== undefined) {
						const gate = alsoResolve
							? await confirmReplyAndResolveGate(
									ctx,
									threadForGate,
									params.replyBody,
								)
							: await confirmReplyGate(ctx, threadForGate, params.replyBody);
						if (!gate.approved) {
							return {
								content: [{ type: "text", text: gate.reason }],
								details: { ok: false, error: gate.reason },
								isError: true,
							};
						}
						replyBodyToPost = gate.body;
					}
					const result = await replyToThreadAction({
						state,
						index: params.threadIndex,
						body: replyBodyToPost,
						sender: (threadId, body) => replyToThread(pi, threadId, body),
						...(replyExpectation ? { expect: replyExpectation } : {}),
					});
					if (!result.ok) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { ok: false, error: result.error },
							isError: true,
						};
					}
					const reply = {
						threadIndex: params.threadIndex,
						url: result.url,
						body: replyBodyToPost,
					};
					if (!alsoResolve) {
						const outcome = describeReplyOutcome(reply, undefined);
						return {
							content: [{ type: "text", text: outcome.text }],
							details: outcome.details,
						};
					}
					// The combined gate (or its headless bypass) already covered
					// the resolution, so resolve without a second gate.
					const resolved = await resolveThreadAction({
						state,
						index: params.threadIndex,
						resolver: (threadId) => resolveThread(pi, threadId),
					});
					const outcome = describeReplyOutcome(
						reply,
						resolved.ok
							? { ok: true, isResolved: resolved.isResolved }
							: { ok: false, error: resolved.error },
					);
					return {
						content: [{ type: "text", text: outcome.text }],
						details: outcome.details,
					};
				}

				if (params.action === "resolve") {
					if (params.threadIndices && params.threadIndices.length > 0) {
						const indices = [...new Set(params.threadIndices)];
						const threadsForGate = indices
							.map((i) => state.threads?.threads[i - 1])
							.filter((t): t is NonNullable<typeof t> => t !== undefined);
						const expectFor = new Map(
							indices.map((i) => [i, captureThreadExpectation(state, i)]),
						);
						if (threadsForGate.length > 0) {
							const gate = await confirmResolveManyGate(ctx, threadsForGate);
							if (!gate.approved) {
								return {
									content: [{ type: "text", text: gate.reason }],
									details: { ok: false, error: gate.reason },
									isError: true,
								};
							}
						}
						const batch = await resolveThreadsAction({
							state,
							indices,
							resolver: (threadId) => resolveThread(pi, threadId),
							expectFor: (i) => expectFor.get(i) ?? undefined,
						});
						const summaryParts = [
							`Resolved ${batch.resolved.length} thread(s)` +
								(batch.resolved.length > 0
									? `: ${batch.resolved.map((i) => `[T${i}]`).join(", ")}`
									: ""),
						];
						if (batch.failed.length > 0) {
							summaryParts.push(
								`Failed: ${batch.failed
									.map((f) => `[T${f.index}] ${f.error}`)
									.join("; ")}`,
							);
						}
						return {
							content: [{ type: "text", text: summaryParts.join(" ") }],
							details: {
								ok: batch.resolved.length > 0,
								resolved: batch.resolved,
								failed: batch.failed,
							},
							...(batch.resolved.length === 0 ? { isError: true } : {}),
						};
					}
					if (typeof params.threadIndex !== "number") {
						return {
							content: [
								{
									type: "text",
									text: "resolve requires a `threadIndex` (or `threadIndices` for a batch) argument.",
								},
							],
							details: { ok: false, error: "missing threadIndex" },
							isError: true,
						};
					}
					const threadForGate = state.threads?.threads[params.threadIndex - 1];
					// Capture identity + version before the gate await for
					// the same reason as reply: the gate yields, and a
					// concurrent refetch must not redirect the resolve.
					const resolveExpectation = captureThreadExpectation(
						state,
						params.threadIndex,
					);
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
						...(resolveExpectation ? { expect: resolveExpectation } : {}),
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
					const result = await nextFixAction(state, (request) =>
						fixWorktreeProviders.provision(request),
					);
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
					const entries = await fixWorktreeProviders.list();
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
					const outcome = await fixWorktreeProviders.cleanup({
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

				if (params.action === "worktree-list") {
					const handles = await worktreeProviders.list();
					if (handles.length === 0) {
						return {
							content: [{ type: "text", text: "No review worktrees on disk." }],
							details: { ok: true, handles: [] },
						};
					}
					const lines = [
						`${handles.length} review worktree${handles.length === 1 ? "" : "s"} on disk:`,
						"",
					];
					for (const handle of handles) {
						lines.push(
							`  ${handle.sha}  (created ${handle.createdAt.toISOString()})`,
						);
						lines.push(`    ${handle.path}`);
					}
					lines.push("");
					lines.push(
						"Call action=worktree-cleanup sha=<sha> to remove one. A prefix is enough.",
					);
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { ok: true, handles },
					};
				}

				if (params.action === "worktree-cleanup") {
					const sha = params.sha?.trim();
					if (!sha) {
						return {
							content: [
								{
									type: "text",
									text: "worktree-cleanup requires a `sha` argument (a value worktree-list prints; a prefix is enough).",
								},
							],
							details: { ok: false, error: "missing sha argument" },
							isError: true,
						};
					}
					const selection = selectWorktreeBySha(
						await worktreeProviders.list(),
						sha,
					);
					if (selection.status === "missing") {
						return {
							content: [
								{
									type: "text",
									text: `No review worktree matches sha "${sha}". Run action=worktree-list to see what is on disk.`,
								},
							],
							details: { ok: false, error: "no matching worktree" },
							isError: true,
						};
					}
					if (selection.status === "ambiguous") {
						const shas = selection.matches.map((h) => h.sha).join(", ");
						return {
							content: [
								{
									type: "text",
									text: `Sha "${sha}" matches more than one review worktree: ${shas}. Use a longer prefix.`,
								},
							],
							details: { ok: false, error: "ambiguous sha" },
							isError: true,
						};
					}
					try {
						await worktreeProviders.release(selection.handle);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: `Failed to remove ${selection.handle.path}: ${message}`,
								},
							],
							details: { ok: false, error: message },
							isError: true,
						};
					}
					return {
						content: [
							{ type: "text", text: `Removed ${selection.handle.path}.` },
						],
						details: { ok: true, removed: selection.handle },
					};
				}

				if (params.action === "release-identity-lock") {
					const id = params.reviewerId?.trim();
					if (!id) {
						return {
							content: [
								{
									type: "text",
									text: "release-identity-lock requires `reviewerId`.",
								},
							],
							details: { ok: false, error: "missing reviewerId" },
							isError: true,
						};
					}
					const existing = state.participantIdentities.get(id);
					if (!existing) {
						return {
							content: [
								{
									type: "text",
									text: `Participant id "${id}" is not currently locked; nothing to release.`,
								},
							],
							details: { ok: true, released: false },
						};
					}
					state.participantIdentities.delete(id);
					const stillReferenced = hasFindingsForParticipant(state, id);
					const note = stillReferenced
						? " Findings from the previous identity remain in state with their original " +
							"attribution string."
						: "";
					return {
						content: [
							{
								type: "text",
								text:
									`Released identity lock for "${id}". ` +
									"Next council-config or judge-config call may bind a new model to that id." +
									note,
							},
						],
						details: { ok: true, released: true, stillReferenced },
					};
				}

				if (params.action === "summary") {
					const text = formatPrSummary(state);
					return {
						content: [{ type: "text", text }],
						details: { ok: true },
					};
				}

				if (params.action === "personas") {
					const loaded = await loadPersonas(personasDir());
					return {
						content: [{ type: "text", text: formatPersonaList(loaded) }],
						details: {
							ok: true,
							personas: loaded.personas.map((p) => ({
								id: p.id,
								name: p.name,
								description: p.description,
							})),
							errors: loaded.errors,
						},
					};
				}

				if (
					params.action === "persona-add" ||
					params.action === "persona-edit"
				) {
					const validated = requirePersonaWrite(params);
					if (!validated.ok) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { ok: false, error: validated.error },
							isError: true,
						};
					}
					const write = validated.write;
					const dir = personasDir();
					const result =
						params.action === "persona-add"
							? await addPersona(dir, write)
							: await editPersona(dir, write);
					if (!result.ok) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { ok: false, error: result.error },
							isError: true,
						};
					}
					const verb = params.action === "persona-add" ? "Created" : "Updated";
					return {
						content: [
							{
								type: "text",
								text: `${verb} persona "${write.id}" in ${dir}.`,
							},
						],
						details: { ok: true, id: write.id, dir },
					};
				}

				if (params.action === "persona-remove") {
					if (params.persona === undefined || params.persona.trim() === "") {
						const error = "persona-remove requires a `persona` (id) argument.";
						return {
							content: [{ type: "text", text: error }],
							details: { ok: false, error },
							isError: true,
						};
					}
					const dir = personasDir();
					const result = await removePersona(dir, params.persona);
					if (!result.ok) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { ok: false, error: result.error },
							isError: true,
						};
					}
					return {
						content: [
							{ type: "text", text: `Removed persona "${params.persona}".` },
						],
						details: { ok: true, id: params.persona },
					};
				}

				if (params.action === "audit-threads") {
					if (state.council.judge === null) {
						const error =
							"No judge configured to act as the auditor. Call " +
							"pr_workflow action=judge-config first.";
						return {
							content: [{ type: "text", text: error }],
							details: { ok: false, error },
							isError: true,
						};
					}
					const auditor = state.council.judge;
					const progress = createCouncilProgressReporter(
						ctx,
						progressControls(),
					);
					const result = await runWithCancellableReviewers(
						"audit-threads",
						({ registry, dispatch }) =>
							auditThreadsAction({
								state,
								registry,
								dispatch,
								auditor,
								fetchThreads: (ref) => fetchReviewThreads(pi, ref),
								progress,
							}),
						progress,
					);
					if (!result.ok) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { ok: false, error: result.error },
							isError: true,
						};
					}
					// A positive audited count with no verdicts means the
					// auditor ran but returned nothing parseable; do not let
					// that read as a clean "nothing to audit", and surface the
					// diagnostics in the visible output rather than only in
					// details.
					const auditParseFailed =
						result.audited > 0 && result.verdicts.length === 0;
					const auditText = auditParseFailed
						? `The auditor returned no usable verdicts for ${result.audited} thread(s). ` +
							"Re-run action=audit-threads."
						: formatThreadAudit(result.verdicts, result.indexById);
					const auditBody =
						result.warnings.length > 0
							? `${auditText}\n\nWarnings:\n${result.warnings
									.map((w) => `  - ${w}`)
									.join("\n")}`
							: auditText;
					return {
						content: [{ type: "text", text: auditBody }],
						details: {
							ok: !auditParseFailed,
							verdicts: result.verdicts,
							warnings: result.warnings,
						},
						...(auditParseFailed ? { isError: true } : {}),
					};
				}

				if (params.action === "reset") {
					const previous = state.pr
						? `${state.pr.reference.owner}/${state.pr.reference.repo}#${state.pr.reference.number}`
						: "none";
					resetPrWorkflowSession(state);
					clearPrStatusLine(ctx);
					// The previous PR is no longer the active resource,
					// so reclaim the worktrees it held (draining any
					// in-flight run first).
					const reclaimed = await reclaimSessionWorktrees();
					const reclaimNote =
						reclaimed.released > 0
							? ` Released ${reclaimed.released} review worktree(s).`
							: "";
					const reclaimWarning =
						reclaimed.errors.length > 0
							? ` Some worktrees could not be released: ${reclaimed.errors.join("; ")}.`
							: "";
					return {
						content: [
							{
								type: "text",
								text:
									"PR workflow session reset. " +
									`Previous PR: ${previous}. ` +
									"Reviewer roster and judge config were kept." +
									reclaimNote +
									reclaimWarning,
							},
						],
						details: {
							ok: true,
							previousPr: previous,
							released: reclaimed.released,
							releaseErrors: reclaimed.errors,
						},
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
						`worktree providers: ${worktreeProviders.providerIds().join(", ")}`,
						`fix worktree providers: ${fixWorktreeProviders.providerIds().join(", ")}`,
						`council roster: ${state.council.roster.length} reviewer(s)`,
						`council last run: ${state.council.lastRun?.id ?? "none"}`,
						`judge: ${state.council.judge?.id ?? "unset"}`,
						`judge last run: ${state.council.lastJudge?.id ?? "none"}`,
						`critique last run: ${state.council.lastCritique?.id ?? "none"}`,
						`cross-PR finding run: ${state.stackFindingRun?.id ?? "none"}`,
						`cross-PR findings: ${state.stackFindingRun?.findings.length ?? 0} (${state.stackDecisions.size} decided)`,
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

				const previousRef = state.pr?.reference ?? null;
				// A bare PR number needs an owner/repo to resolve
				// against. Derive it from the checkout's origin
				// remote so `load pr:123` works in a repo without
				// spelling out owner/repo. Only consulted for a
				// bare number, so a full ref never pays the git cost.
				const defaultRepo = /^\d+$/.test(params.pr.trim())
					? await getCurrentRepo(pi)
					: null;
				const outcome = loadPr(state, {
					input: params.pr,
					...(defaultRepo ? { defaultRepo } : {}),
				});
				if (!outcome.ok) {
					return {
						content: [{ type: "text", text: outcome.error }],
						details: { ok: false, error: outcome.error },
						isError: true,
					};
				}

				const loaded = state.pr;
				// Switching to a different PR retires the previous
				// one as the active resource, so reclaim the
				// worktrees it held. A reload of the same PR keeps
				// them for reuse.
				if (
					previousRef &&
					loaded &&
					(previousRef.owner !== loaded.reference.owner ||
						previousRef.repo !== loaded.reference.repo ||
						previousRef.number !== loaded.reference.number)
				) {
					const reclaimed = await reclaimSessionWorktrees();
					// The reviewer cache is keyed by reviewed content, so
					// entries from the previous PR can never be reused here;
					// drop them on the switch so the cache does not grow with
					// every PR visited in a session.
					state.council.reviewerCache.clear();
					// Surface the outcome the way reset does, so a release
					// failure on the switch edge is not silent.
					if (reclaimed.errors.length > 0) {
						ctx.ui.notify(
							`Switching PRs: ${reclaimed.errors.length} review worktree(s) from the previous PR could not be released: ${reclaimed.errors.join("; ")}.`,
							"warning",
						);
					}
				}
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
					const message =
						error instanceof Error ? error.message : String(error);
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

				// When quest-workflow is loaded, attach the PR to
				// its tree: load the existing sidequest or scaffold
				// a new one under the user's loaded quest. The
				// integration is additive: when the bridge isn't
				// registered, this block is a no-op.
				const questBridge = getQuestPrBridge();
				let questSidequest: {
					sidequestId: string;
					isNew: boolean;
					parentQuestId: string | null;
				} | null = null;
				if (questBridge) {
					try {
						const sidequest = findOrCreateSidequestForPr(
							{
								owner: loaded.reference.owner,
								repo: loaded.reference.repo,
								number: loaded.reference.number,
							},
							{
								questsRoot: questBridge.questsRoot(),
								parentQuestId: questBridge.loadedQuestId(),
								title: loaded.metadata?.title,
								authorHandle: loaded.metadata?.author,
								url: loaded.metadata?.url,
							},
						);
						questSidequest = {
							sidequestId: sidequest.sidequestId,
							isNew: sidequest.isNew,
							parentQuestId: sidequest.parentQuestId,
						};
						if (!sidequest.isNew) {
							questBridge.logJourney(
								sidequest.sidequestDir,
								`Reloaded for review (${loaded.reference.owner}/${loaded.reference.repo}#${loaded.reference.number}).`,
							);
						}
						lines.push("");
						lines.push(
							sidequest.isNew
								? `Scaffolded quest sidequest ${sidequest.sidequestId}${sidequest.parentQuestId ? ` under ${sidequest.parentQuestId}` : ""}.`
								: `Linked to existing quest sidequest ${sidequest.sidequestId}.`,
						);
					} catch (error) {
						lines.push("");
						lines.push(
							`Quest-workflow integration failed: ${(error as Error).message}`,
						);
					}
				}

				const suggestedNext = suggestNextAfterLoad(state);
				for (const line of formatLoadSuggestions(suggestedNext)) {
					lines.push(line);
				}
				// Persist fires once after the action returns, from the
				// dispatch wrapper below, so there is no per-action call
				// to make here.
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						ok: true,
						pr: loaded,
						suggestedNext,
						questSidequest,
					},
				};
			};

			// Persist the state slice once the action has run, rather
			// than on every tool call. pr-workflow actions are the
			// only thing that mutates this slice, so this fires
			// persist exactly when it can change and never on an
			// unrelated bash or read. The dirty check inside persist
			// drops actions that changed nothing.
			const handleActionAndPersist = async (): Promise<
				Awaited<ReturnType<typeof handleAction>>
			> => {
				try {
					return await handleAction();
				} finally {
					persist(state, pi, resultsStore);
				}
			};

			// Route quick mutations through the FIFO lane so their
			// read-modify-write windows can't interleave; everything
			// else runs free. See QUICK_MUTATION_ACTIONS above.
			if (QUICK_MUTATION_ACTIONS.has(params.action)) {
				return actionMutex.runExclusive(handleActionAndPersist);
			}
			return handleActionAndPersist();
		},
	});

	// Restore the persisted config slice on every session
	// start: this is what makes `/reload` non-destructive
	// for the user's roster and judge
	// configuration. See lifecycle.ts for what is and
	// isn't persisted.
	pi.on("session_start", async (_event, ctx) => {
		restore(state, pi, ctx, resultsStore);
		if (state.degradedRunNotice)
			ctx.ui.notify(state.degradedRunNotice, "warning");
		refreshPrStatusLine(ctx, state);
	});

	// Push the latest overview line after every tool call. The
	// status-line refresh is cheap and wants to catch any tool
	// that might have shifted the PR context (PR #198).
	// Persistence used to ride along here, but firing it on every
	// bash and read is what bloated the session log; it now fires
	// from the action dispatch wrapper, the only place the state
	// slice changes.
	pi.on("tool_result", async (_event, ctx) => {
		refreshPrStatusLine(ctx, state);
	});

	pi.on("agent_end", async (_event, ctx) => {
		refreshPrStatusLine(ctx, state);
	});

	// Release the session's review worktrees on shutdown. Pi
	// emits session_shutdown on graceful exit, reload, switch,
	// fork and clone, so this is the deterministic reclaim
	// edge for the common case. A hard kill never reaches
	// here; the manual worktree-cleanup verb covers those
	// orphans. Best-effort: a stuck release must not block
	// pi's teardown.
	pi.on("session_shutdown", async () => {
		try {
			await reclaimSessionWorktrees();
		} catch {
			// Teardown is best-effort; reclaimWorktrees already
			// collects release failures, so a throw here would be
			// unexpected, but we still refuse to fail shutdown.
		}
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
	for (const [name, stage] of stages) {
		if (stage.total === undefined) continue;
		lines.push(`  ${name}: ${formatUsage(stage.total)}`);
		// Show the per-reviewer breakdown only when more than
		// one reviewer contributed; a single-reviewer stage
		// (judge in the common case) would just duplicate the
		// total line.
		if (stage.perReviewer.length > 1) {
			for (const entry of stage.perReviewer) {
				lines.push(`    ${entry.reviewerId}: ${formatUsage(entry.usage)}`);
			}
		}
	}
	lines.push(`  total: ${formatUsage(breakdown.total)}`);
	return lines;
}

/**
 * Prose summary for the `preview-post` action. Mirrors
 * the post-action's one-line summary but framed as a
 * dry run and surfaces the skip reasons inline so the
 * user can fix locations before actually posting.
 *
 * When the diff isn't loaded the inline-vs-body split is
 * provisional: `buildReviewPayload` skips the anchor
 * check and counts every line-kind finding as inline,
 * which doesn't match what GitHub will accept. The hint
 * tells the user to call `action=load` first if they
 * want a faithful preview.
 */
function formatPreviewPostSummary(
	payload: ReviewPayload,
	diffLoaded: boolean,
): string {
	const inline = payload.comments.length;
	const included = payload.includedFindingIds.length;
	const stack = payload.includedStackFindingIds.length;
	const bodyBound = included + stack - inline;
	const lines: string[] = [];
	lines.push(
		`Preview: ${included} per-PR finding(s) + ${stack} stack finding(s) ready to post.`,
	);
	lines.push(
		`  inline comments: ${inline}; body entries: ${bodyBound}; skipped: ${payload.skipped.length}.`,
	);
	if (!diffLoaded) {
		lines.push(
			"  ! diff not loaded; the inline/body split is provisional. " +
				"Call action=load to fetch the diff for a faithful preview.",
		);
	}
	if (payload.skipped.length > 0) {
		lines.push("");
		lines.push("Skipped findings:");
		for (const skip of payload.skipped) {
			lines.push(`  - [${skip.findingId}] ${skip.reason}`);
		}
	}
	return lines.join("\n");
}

/**
 * Verbose preview output: same summary header as the
 * default, plus the actual review body markdown and a
 * compact list of every inline comment the post step
 * would send. Use this before `action=post` when you
 * want to read what GitHub will receive rather than
 * trust the inline/body counts.
 */
function formatPreviewPostVerbose(
	payload: ReviewPayload,
	diffLoaded: boolean,
	wrappedBody: string,
): string {
	const lines: string[] = [formatPreviewPostSummary(payload, diffLoaded)];
	lines.push("");
	lines.push("## Review body");
	lines.push("");
	// `post` sends the body that `renderSummary` wraps
	// around `payload.body` (verdict intro + prefix +
	// thread context). Mirror that here so what users
	// preview matches what GitHub receives.
	lines.push(wrappedBody.trim().length === 0 ? "(empty)" : wrappedBody);
	if (payload.comments.length > 0) {
		lines.push("");
		lines.push(`## Inline comments (${payload.comments.length})`);
		for (const comment of payload.comments) {
			const loc =
				comment.startLine !== undefined && comment.startLine !== comment.line
					? `${comment.path}:${comment.startLine}-${comment.line}`
					: `${comment.path}:${comment.line}`;
			lines.push("");
			lines.push(`### ${loc} (${comment.side})`);
			lines.push(comment.body);
		}
	}
	return lines.join("\n");
}

function formatUsage(usage: NonNullable<UsageBreakdown["total"]>): string {
	const tokens = usage.tokens.total.toLocaleString("en-CA");
	const cost = usage.cost.total.toFixed(4);
	return `${tokens} tokens, $${cost}`;
}

interface BuildDecideInputArgs {
	findingId: number;
	verdict: "endorse" | "qualify" | "edit" | "dismiss" | "promote" | "fix";
	note: string | undefined;
	subject: string | undefined;
	discussion: string | undefined;
	reason: string | undefined;
	instructions: string | undefined;
	scope: "pr" | "stack" | undefined;
	label: ConventionalLabel | undefined;
	decorations: readonly string[] | undefined;
	file: string | undefined;
	start: number | undefined;
	end: number | undefined;
	side: "old" | "new" | "both" | undefined;
}

function buildDecideInput(args: BuildDecideInputArgs): DecideFindingInput {
	const { findingId, verdict, scope } = args;
	switch (verdict) {
		case "endorse":
			return { findingId, verdict: "endorse", scope };
		case "qualify":
			return { findingId, verdict: "qualify", note: args.note ?? "", scope };
		case "edit":
			return {
				findingId,
				verdict: "edit",
				subject: args.subject,
				discussion: args.discussion,
				label: args.label,
				...(args.decorations !== undefined
					? { decorations: args.decorations }
					: {}),
				file: args.file,
				start: args.start,
				end: args.end,
				side: args.side,
				scope,
			};
		case "dismiss":
			return { findingId, verdict: "dismiss", reason: args.reason, scope };
		case "promote":
			return { findingId, verdict: "promote", scope };
		case "fix":
			return {
				findingId,
				verdict: "fix",
				instructions: args.instructions,
				scope,
			};
	}
}
