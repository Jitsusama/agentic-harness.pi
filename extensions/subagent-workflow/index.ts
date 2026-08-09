/**
 * Subagent Workflow extension.
 *
 * Exposes a single `subagent` tool: fan N pi processes
 * out concurrently, each with its own persona, model,
 * tool palette and prompts. Returns each subagent's final
 * assistant text so the calling agent can synthesise,
 * compare or hand the outputs to the user.
 *
 * Three workloads were considered when sizing the API:
 *
 * - **Persona sweeps**: same problem, several roles
 *   (security/perf/readability). Different
 *   `systemPrompt`, same `userPrompt`.
 * - **Multi-angle investigation**: same area, different
 *   questions. Same `cwd`, different `userPrompt` per
 *   subagent.
 * - **Fleet brainstorming**: N copies of the same
 *   prompt across N models, asking for divergent
 *   answers. Same `userPrompt`, different `model`.
 *
 * The tool's parameters cover all three with a flat
 * `jobs[]` array. No worktree provisioning, no session
 * state, no orchestration heroics: the host agent
 * composes jobs and the tool runs them.
 *
 * The `subagent-fleet-guide` skill teaches the methodology
 * (when to fan out, persona shapes, cost etiquette); this
 * extension provides the substrate.
 *
 * Cancellation: ↑/↓ to select a subagent in the focused
 * progress panel, `r` to cancel the selected one, `Esc`
 * to cancel the whole fleet. Cancellation flows through
 * the engine's abort signal and surfaces as `cancelled`
 * state in the result payload.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { packageStateDir } from "../../lib/internal/package-state-dir.js";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.js";
import {
	registerSubagentDefaultExtension,
	registerSubagentDefaultSkill,
} from "../../lib/subagent/defaults.js";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
	SUBAGENT_REGISTER_DEFAULT_SKILL,
} from "../../lib/subagent/events.js";
import { createFleetLedger } from "../../lib/subagent/fleet.js";
import { getParentPiInstall } from "../../lib/subagent/install.js";
import { createSupervisorRunPi } from "../../lib/subagent/runpi/supervisor.js";
import { THINKING_LEVELS } from "../../lib/thinking/index.js";
import {
	FleetCancellationRegistry,
	formatFleetCancellation,
} from "./cancellation.js";
import { createFleetProgressReporter } from "./progress-render.js";
import {
	buildAssignment,
	dispatchFleet,
	type FleetAssignment,
	formatFleetSummary,
	locateArtifacts,
} from "./run.js";

/**
 * The domain's bus names, re-exported under their old spellings.
 *
 * They are declared in `lib/subagent/events.ts` now, because a name
 * that only an extension can hand you is a name a downstream package
 * has to hardcode. These aliases stay so nothing importing them
 * breaks; the names on the wire moved from `subagent-workflow:` to
 * `subagent:`, since a topic belongs to a domain rather than to
 * whichever extension currently hosts it.
 */
export const SUBAGENT_WORKFLOW_READY = SUBAGENT_READY;

/** See {@link SUBAGENT_REGISTER_DEFAULT_EXTENSION}. */
export const SUBAGENT_WORKFLOW_REGISTER_DEFAULT_EXTENSION =
	SUBAGENT_REGISTER_DEFAULT_EXTENSION;

/** See {@link SUBAGENT_REGISTER_DEFAULT_SKILL}. */
export const SUBAGENT_WORKFLOW_REGISTER_DEFAULT_SKILL =
	SUBAGENT_REGISTER_DEFAULT_SKILL;

/**
 * Public hook surface for other pi extensions. Delivered
 * via the {@link SUBAGENT_WORKFLOW_READY} event. The two
 * methods are thin wrappers around the engine-wide
 * registry in `lib/subagent/defaults.ts`; calling them
 * from one extension makes the registered path available
 * to every subagent that any consumer spawns for the rest
 * of the session.
 */
export interface SubagentWorkflowApi {
	/**
	 * Inject this extension into every subagent. Absolute
	 * path to a `.ts`, `.mjs`, or directory-with-`index.ts`.
	 */
	registerDefaultExtension(path: string): void;
	/**
	 * Inject this skill into every subagent. Absolute path
	 * to a `SKILL.md` file.
	 */
	registerDefaultSkill(path: string): void;
}

// Raw fleet run directories (per-subagent events, stderr and
// result files) are only needed while a run is live or under
// recovery, so they age out on a bounded window and count.
const FLEET_RUNS_RETAIN = 100;
const FLEET_RUNS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A run killed before its reviewer wrote a result is not terminal, so
// the terminal-only sweep could never reclaim it and it lived forever.
// Four times the normal window, because an unfinished run is kept for
// recovery and the question is whether anybody could still resume it.
const FLEET_RUNS_ABANDONED_AFTER_MS = 4 * FLEET_RUNS_MAX_AGE_MS;
/**
 * How many unread fleets to hold before saying so out loud.
 *
 * Protection is absolute, so the population it holds is the one that
 * can grow without a limit, and nothing else would ever mention it: a
 * fleet nobody collected is by definition one nobody knows about.
 */
const FLEETS_HELD_BEFORE_SAYING = 5;

/**
 * Do a piece of bookkeeping, and say so if it fails.
 *
 * Bookkeeping must never cost a fleet. A ledger write that throws
 * would take down a dispatch that is otherwise fine, or turn the end
 * of an expensive fleet into an exception that throws away everything
 * it found. Said out loud rather than swallowed, because what a
 * failure here costs is a fleet nothing protects or a fleet nothing
 * ever releases, and neither is visible from anywhere else.
 */
async function recordOrSay(work: Promise<void>, cost: string): Promise<void> {
	try {
		await work;
	} catch (error) {
		console.error(
			`[subagent-workflow] ${cost}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export default function subagentWorkflow(pi: ExtensionAPI) {
	const stateDir = () => packageStateDir("subagent-workflow");
	// Beside the run directories rather than inside them: this is a
	// small file read at every session start, and those are megabytes
	// of event stream per subagent. The run id is the key on both
	// sides, so either points at the other without holding it.
	const fleetDir = () => join(stateDir(), "fleets");
	const cancellations = new FleetCancellationRegistry();

	// Prune old fleet run directories at session start so the raw
	// artifacts they hold do not accumulate unbounded. A finished run
	// goes on the normal window; an unfinished one is kept far longer,
	// for recovery, but not forever.
	pi.on("session_start", async () => {
		// Both paths up front, before anything is awaited. They resolve
		// against the environment each time they are called and this runs
		// unawaited, so a lookup after the first await is a lookup
		// against whatever the environment says by then.
		const runs = stateDir();
		const fleets = fleetDir();
		try {
			const { open, unreadable } = await createFleetLedger(fleets).openFleets();
			if (unreadable.length > 0) {
				// Declined rather than swept with an empty protect set. An
				// empty set is not the cautious reading of a ledger that
				// will not open: a fleet's transcripts are the only copy of
				// what it said, so sweeping without knowing which are
				// spoken for deletes exactly the work this protects.
				console.error(
					`[subagent-workflow] fleet runs will not be swept while ${unreadable.join(", ")} cannot be read, because nothing can then say which fleets nobody has collected. Nothing repairs those files on their own, so this holds for every session until they are fixed or moved aside.`,
				);
				return;
			}
			if (open.size >= FLEETS_HELD_BEFORE_SAYING) {
				console.error(
					`[subagent-workflow] ${open.size} fleet runs were dispatched and never handed back, so their transcripts are held under ${runs} and nothing will reclaim them.`,
				);
			}
			const swept = await new ReviewerArtifactsStore(runs).cleanupTerminalRuns({
				maxRuns: FLEET_RUNS_RETAIN,
				maxAgeMs: FLEET_RUNS_MAX_AGE_MS,
				abandonedAfterMs: FLEET_RUNS_ABANDONED_AFTER_MS,
				protect: open,
			});
			// Only the failures, and out loud: a sweep that decided to
			// delete something and could not is a disk filling at a rate
			// nothing reports, and the summary saying so was being dropped.
			for (const warning of swept.warnings) {
				console.error(`[subagent-workflow] fleet runs: ${warning}`);
			}
		} catch (error) {
			// Retention is advisory; a transient sweep failure is fine. Said
			// rather than swallowed, though, for the reason the line above
			// exists: this is the failure that reclaims nothing at all, so
			// reporting the one that misses a single directory and hiding
			// this one gets the priority backwards.
			console.error(
				`[subagent-workflow] fleet runs were not swept: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
	let runPi: ReturnType<typeof createSupervisorRunPi> | null = null;
	const getRunPi = () => {
		if (runPi !== null) return runPi;
		runPi = createSupervisorRunPi({
			piInstall: getParentPiInstall(),
			stateDir: stateDir(),
		});
		return runPi;
	};
	const controls = () => ({
		cancelSubagent: (subagentId: string) =>
			formatFleetCancellation(cancellations.cancel(subagentId)),
		cancelAll: () => formatFleetCancellation(cancellations.cancel()),
	});

	// Announce the registration hook for other pi
	// extensions. A Shopify-style credentials helper that
	// listens here can drop an extension path into the
	// engine-wide registry so even `isolated: true`
	// subagents inherit auth without the user having to
	// thread `extraExtensions` through every job.
	//
	// Two-way handshake: extensions that activate BEFORE
	// this one listen for SUBAGENT_WORKFLOW_READY and use
	// the API; extensions that activate AFTER this one
	// missed the emit and instead fire the reverse register
	// events below. The listeners stay subscribed for the
	// session, so timing never matters once both extensions
	// have activated.
	const registerDefaultExtensionFromEvent = (payload: unknown): void => {
		if (typeof payload !== "string") return;
		registerSubagentDefaultExtension(payload);
	};
	const registerDefaultSkillFromEvent = (payload: unknown): void => {
		if (typeof payload !== "string") return;
		registerSubagentDefaultSkill(payload);
	};
	pi.events.on(
		SUBAGENT_WORKFLOW_REGISTER_DEFAULT_EXTENSION,
		registerDefaultExtensionFromEvent,
	);
	pi.events.on(
		SUBAGENT_WORKFLOW_REGISTER_DEFAULT_SKILL,
		registerDefaultSkillFromEvent,
	);
	const api: SubagentWorkflowApi = {
		registerDefaultExtension: registerSubagentDefaultExtension,
		registerDefaultSkill: registerSubagentDefaultSkill,
	};
	pi.events.emit(SUBAGENT_WORKFLOW_READY, api);

	pi.registerTool({
		name: "subagent",
		label: "Subagent Fleet",
		description:
			"Fan N pi subagents out concurrently. Each gets its own pi " +
			"process, context window, model, tool palette and working " +
			"directory. Use for persona sweeps (security/performance/" +
			"readability of the same artifact), multi-angle investigation " +
			"(data flow vs lifecycle vs config of the same bug), or fleet " +
			"brainstorming (N answers from N models). Read the " +
			"subagent-fleet-guide skill for when and how. Returns each " +
			"subagent's final assistant text plus aggregate token/cost " +
			"figures.",
		promptSnippet:
			"Spawn parallel pi subagents for persona-driven, multi-angle " +
			"or fan-out work. The skill teaches when to reach for it; this " +
			"is the substrate.",
		parameters: Type.Object({
			jobs: Type.Array(
				Type.Object({
					id: Type.String({
						description:
							"Stable id for this subagent; appears in progress UI and on-disk artifact paths. Restricted to letters, digits, dot, underscore and dash so two ids cannot alias to the same artifact directory after path sanitization.",
						pattern: "^[a-zA-Z0-9._-]+$",
					}),
					model: Type.Optional(
						Type.String({
							description:
								"Pi --model value: bare model id (claude-opus-4-7) or provider/model (anthropic/claude-opus-4-7). Omit to inherit pi's session default.",
						}),
					),
					thinkingLevel: Type.Optional(
						StringEnum(
							// The shared list, so this schema and the one the review
							// tools offer cannot come to disagree about what pi takes.
							THINKING_LEVELS,
							{
								description:
									"Pi --thinking value. Omit to inherit pi's session default.",
							},
						),
					),
					tools: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Tool palette passed via --tools (e.g. [read,grep,glob,ls,bash]). Omit for the default palette.",
						}),
					),
					cwd: Type.String({
						description:
							"Working directory for the subprocess. Use the project root for ad-hoc work, or a worktree path if you need detachment.",
					}),
					systemPrompt: Type.Optional(
						Type.String({
							description:
								"Persona / baseline instructions sent via pi's --system-prompt. Use for role-based fan-outs (security reviewer, performance reviewer, contrarian, ...).",
						}),
					),
					userPrompt: Type.String({
						description:
							"The user prompt the subagent answers. Phrase it the way you'd phrase a question to a teammate; the subagent has the same tools and the same working directory.",
					}),
					isolated: Type.Optional(
						Type.Boolean({
							description:
								"When true, strip ambient inheritance (--no-skills --no-context-files --no-extensions) so the subagent sees only what you attach here. Defaults to true for the fleet tool, so opt out when you want the subagent to share your local pi setup.",
						}),
					),
					extraExtensions: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Absolute paths to inject via --extension. Use for verify packs, custom tools or domain-specific helpers.",
						}),
					),
					extraSkills: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Absolute skill paths to inject via --skill. Use to teach the subagent an output contract or methodology without baking it into the prompt.",
						}),
					),
					timeoutMs: Type.Optional(
						Type.Integer({
							minimum: 1000,
							maximum: 8 * 60 * 60 * 1000,
							description:
								"Hard wall-clock timeout in milliseconds for this subagent. Overrides the runner's configured default. Use for jobs that legitimately run longer than the runner's default: deep investigations, soak tests, multi-step deploys. Per-job override; siblings keep the default. Capped at eight hours.",
						}),
					),
					idleTimeoutMs: Type.Optional(
						Type.Integer({
							minimum: 1000,
							maximum: 8 * 60 * 60 * 1000,
							description:
								"Idle timeout in milliseconds: how long the supervisor waits between progress events before declaring the child stuck. Overrides the runner's configured default. Bump this when the subagent's natural workflow contains long bash commands that stay silent on stdout (benchmark runs, git pushes against large mirrors, gcloud deploys). Per-job override; siblings keep the default. When set above the wall-clock default, also bump `timeoutMs` so the wall clock doesn't fire first. Capped at eight hours.",
						}),
					),
					verify: Type.Optional(
						Type.Object(
							{
								extensionPath: Type.String({
									description:
										"Absolute path to the verify extension entry file.",
								}),
								skillPath: Type.Optional(
									Type.String({
										description:
											"Absolute path to the companion contract skill, when present.",
									}),
								),
							},
							{
								description:
									"Verify pack. When set, the subagent must call verify_output and return ok=true before the engine accepts the run.",
							},
						),
					),
				}),
				{
					description:
						"Subagent jobs to run concurrently. One pi process per job. Order is preserved in the result payload.",
					minItems: 1,
				},
			),
			runId: Type.Optional(
				Type.String({
					description:
						"Stable id for this fleet run. Used for durable supervisor artifacts and progress correlation. Auto-generated when omitted.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runId = params.runId ?? `fleet-${randomUUID()}`;
			const assignments: FleetAssignment[] = params.jobs.map(buildAssignment);
			const progress = createFleetProgressReporter(ctx, controls());
			const ledger = createFleetLedger(fleetDir());
			// Written down before it is dispatched, and best effort. A
			// fleet recorded when it finishes is recorded exactly when
			// nothing needed it to be, since the population this protects
			// is the fleets that never reached their own ending. Best
			// effort because bookkeeping must not cost a fleet: the cost
			// of failing to write is that one fleet goes unprotected, and
			// the cost of throwing is that it never runs at all.
			await recordOrSay(
				ledger.open({
					id: runId,
					startedAt: new Date().toISOString(),
					jobs: assignments.map((one) => one.spec.id),
				}),
				`could not write ${runId} down before dispatching it, so the sweep will not know to keep its transcripts`,
			);
			try {
				const result = await dispatchFleet({
					runId,
					assignments,
					runPi: getRunPi(),
					cancellations,
					progress,
					...(signal ? { signal } : {}),
				});
				// Decorate the result with on-disk artifact paths so the full
				// per-subagent output is discoverable from the summary and the
				// details payload, not buried in the supervisor's state dir.
				const located = locateArtifacts(stateDir(), result);
				return {
					content: [{ type: "text", text: formatFleetSummary(located) }],
					details: { ok: true, ...located },
				};
			} finally {
				// From a finally, because the fleet is settled by having been
				// handed back and a throw hands back too: the caller has the
				// error and can go and look. Settling only on the happy path
				// would protect every failed fleet forever, which is the
				// unbounded population wearing a different hat.
				await recordOrSay(
					ledger.settle(runId),
					`could not settle ${runId}, so its transcripts will be held until somebody clears it`,
				);
			}
		},
	});
}
