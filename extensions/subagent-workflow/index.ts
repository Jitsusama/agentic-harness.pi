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
import { safeSegment } from "../../lib/subagent/errno.js";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
	SUBAGENT_REGISTER_DEFAULT_SKILL,
} from "../../lib/subagent/events.js";
import {
	abandonedFleets,
	createFleetLedger,
	type FleetRun,
} from "../../lib/subagent/fleet.js";
import { getParentPiInstall } from "../../lib/subagent/install.js";
import { systemFacts } from "../../lib/subagent/lease.js";
import { recoverReviewerRuns } from "../../lib/subagent/recovery.js";
import { createSupervisorRunPi } from "../../lib/subagent/runpi/supervisor.js";
import { THINKING_LEVELS } from "../../lib/thinking/index.js";
import { count } from "../../lib/ui/count.js";
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
 * How many sweep failures to print before summarizing the rest.
 *
 * These arrive per run directory, and what causes them is rarely one
 * run: a permissions change lands on all of them at once, so the
 * choice is a cap or a hundred lines at somebody's session start.
 */
const MOST_WARNINGS = 5;

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
async function recordOrSay(
	work: () => Promise<void>,
	cost: string,
): Promise<void> {
	try {
		// Called here rather than taken as a started promise, so a
		// synchronous throw on the way in is caught by the guard it was
		// meant for rather than escaping past it.
		await work();
	} catch (error) {
		console.error(
			`[subagent-workflow] ${cost}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Give back the disk that finished fleets are still holding.
 *
 * Its own function rather than an event handler body, because it is
 * four policies in a row and a handler should say which ones rather
 * than be them.
 */
/**
 * Stop a subagent whose supervisor died, and say that it stopped.
 *
 * The narrow case, and the only orphan a fleet can have. A supervisor
 * whose session goes stops its own child within half a second, since
 * a fleet job is always one somebody is waiting for and its request
 * carries the waiting pid; that is asserted against the real script
 * in `tests/lib/subagent/runpi/parent-exit.test.ts`. So a dead
 * session leaves nothing running, and no ledger reading is needed to
 * work out whose fleet this was.
 *
 * A supervisor that is itself killed is the gap. Its child was
 * spawned into its own process group and outlives it, holding an
 * expensive model against a wall clock nothing is watching, and the
 * pid was only ever known to the process that died.
 */
/**
 * This session, as something a later one can check.
 *
 * A pid alone identifies nothing: the number comes round again, and a
 * stranger wearing it reads as this session still being here. So the
 * birthday goes with it, and when the machine will not report one the
 * answer is nothing at all rather than a pid on its own, since absent
 * is read as "still waiting" and a bare pid would be read as proof.
 *
 * Asked once. It cannot change, and asking costs a subprocess.
 */
async function whoIsWaiting(): Promise<FleetRun["owner"]> {
	if (waiting === undefined) {
		const startedAt = await systemFacts.startedAt(process.pid);
		waiting = startedAt === undefined ? null : { pid: process.pid, startedAt };
	}
	return waiting ?? undefined;
}

/** Cached, with null meaning the machine would not say. */
let waiting: FleetRun["owner"] | null | undefined;

async function stopOrphanedSubagents(runs: string): Promise<void> {
	try {
		const { reaped } = await recoverReviewerRuns(
			new ReviewerArtifactsStore(runs),
		);
		if (reaped.length === 0) return;
		// Said out loud. A session that quietly kills processes it finds
		// running is worse than one that leaves them, and whoever is
		// paying for those tokens should hear that they stopped.
		console.error(
			`[subagent-workflow] stopped ${count(reaped.length, "subagent")} whose supervisor had died: ${reaped
				.map((one) => `${one.runId}/${one.reviewerId}`)
				.join(", ")}`,
		);
	} catch (error) {
		// Advisory, like the sweep beside it: a session that cannot
		// check for orphans is still a session.
		console.error(
			`[subagent-workflow] could not look for orphaned subagents: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function sweepFleetRuns(runs: string, fleets: string): Promise<void> {
	const transcripts = join(runs, "runs");
	const ledger = createFleetLedger(fleets);
	try {
		const { open, unreadable } = await ledger.openFleets();
		if (unreadable.length > 0) {
			// Declined rather than swept with an empty protect set. An
			// empty set is not the cautious reading of a ledger that will
			// not open: a fleet's transcripts are the only copy of what it
			// said, so sweeping without knowing which are spoken for
			// deletes exactly the work this protects.
			console.error(
				`[subagent-workflow] fleet runs will not be swept while ${unreadable.join(", ")} cannot be read, because nothing can then say which fleets nobody has collected. Nothing repairs those files on their own, so this holds for every session until they are fixed or moved aside.`,
			);
			return;
		}
		const swept = await new ReviewerArtifactsStore(runs).cleanupTerminalRuns({
			maxRuns: FLEET_RUNS_RETAIN,
			maxAgeMs: FLEET_RUNS_MAX_AGE_MS,
			abandonedAfterMs: FLEET_RUNS_ABANDONED_AFTER_MS,
			protect: open,
		});
		// What the sweep held, not what the ledger holds. They are
		// different numbers: a fleet can be open on the ledger and have
		// no transcripts at all, and announcing megabytes that are not
		// there sends somebody looking for a directory that does not
		// exist.
		//
		// Held is not the same question as abandoned, either. A fleet
		// another session is running right now is held, and saying so
		// invites somebody to delete the record protecting work that is
		// still being paid for. Only the ones nobody is waiting for are
		// worth a word, and they are the ones where the offer to delete
		// is safe to make.
		const gone = await abandonedFleets(
			(await ledger.everyFleet()).runs.filter((run) => run.open === true),
			systemFacts,
		);
		if (swept.held >= FLEETS_HELD_BEFORE_SAYING && gone.length > 0) {
			console.error(
				`[subagent-workflow] ${count(gone.length, "fleet")} of the ${swept.held} being held was dispatched by a session that never came back for it, so its transcripts under ${transcripts} are final and nothing will reclaim them: ${gone
					.map((run) => run.id)
					.join(
						", ",
					)}. Delete a fleet's file under ${fleets} to release the one it names.`,
			);
		}
		// Capped, because what produces these is rarely one run: a
		// permissions change lands on all of them at once, and the two
		// lines above carry decisions somebody has to see.
		for (const warning of swept.warnings.slice(0, MOST_WARNINGS)) {
			console.error(`[subagent-workflow] fleet runs: ${warning}`);
		}
		if (swept.warnings.length > MOST_WARNINGS) {
			console.error(
				`[subagent-workflow] and ${swept.warnings.length - MOST_WARNINGS} more like it, which together say ${transcripts} is not writable rather than that one fleet is stuck.`,
			);
		}
		// Last, and only once the sweep has run, so a record is dropped
		// after the transcripts it points at have gone rather than
		// before. The window is the transcripts' own longest one.
		await ledger.forgetSettledBefore(
			new Date(Date.now() - FLEET_RUNS_ABANDONED_AFTER_MS),
		);
	} catch (error) {
		// Retention is advisory; a transient sweep failure is fine. Said
		// rather than swallowed, though, for the reason the cap above
		// exists: this is the failure that reclaims nothing at all, so
		// reporting the one that misses a single directory and hiding
		// this one gets the priority backwards.
		console.error(
			`[subagent-workflow] fleet runs were not swept: ${error instanceof Error ? error.message : String(error)}`,
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
	//
	// Both paths are resolved here, before anything is awaited. They
	// resolve against the environment each time they are called and
	// this runs unawaited, so a lookup after the first await is a
	// lookup against whatever the environment says by then.
	pi.on("session_start", () => {
		// Not returned. Nothing about reclaiming disk should delay a
		// session, and the sibling extension does the same: a handler
		// that awaits this makes every start wait on a directory walk.
		void sweepFleetRuns(stateDir(), fleetDir());
		void stopOrphanedSubagents(stateDir());
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
					// Held to the same shape a job id is held to, and for a
					// sharper reason: this one keys both the transcript
					// directory and the ledger record that protects it, so two
					// ids that sanitize alike share protection, and one
					// finishing releases the other's.
					pattern: "^[a-zA-Z0-9._-]+$",
					description:
						"Stable id for this fleet run. Used for durable supervisor artifacts, the ledger entry that keeps them, and progress correlation. Letters, digits, dot, underscore and dash, so it names exactly one run on disk. Auto-generated when omitted.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runId = params.runId ?? `fleet-${randomUUID()}`;
			const assignments: FleetAssignment[] = params.jobs.map(buildAssignment);
			const progress = createFleetProgressReporter(ctx, controls());
			// Both up front, for the reason the sweep resolves its paths up
			// front: these read the environment on every call, and a fleet
			// can run for hours, so a lookup after the dispatch is a lookup
			// against whatever the environment says by then.
			const runs = stateDir();
			const fleets = fleetDir();
			const ledger = createFleetLedger(fleets);
			// Written down before it is dispatched, and best effort. A
			// fleet recorded when it finishes is recorded exactly when
			// nothing needed it to be, since the population this protects
			// is the fleets that never reached their own ending. Best
			// effort because bookkeeping must not cost a fleet: the cost
			// of failing to write is that one fleet goes unprotected, and
			// the cost of throwing is that it never runs at all.
			// Who is waiting, so a later session can tell a fleet running
			// right now from one whose session never came back for it.
			// Both are open records and they want opposite things said
			// about them: the first is nobody else's business, and the
			// second is transcripts that are final and worth reading.
			const owner = await whoIsWaiting();
			await recordOrSay(
				() =>
					ledger.open({
						id: runId,
						startedAt: new Date().toISOString(),
						jobs: assignments.map((one) => one.spec.id),
						...(owner ? { owner } : {}),
					}),
				`could not write ${runId} down before dispatching it, so the sweep will not know to keep its transcripts`,
			);
			// What, if anything, was cut off before it could answer. Set
			// inside the try and read in the finally, because the finally
			// is the only place that sees both endings.
			let cutOff: string | undefined =
				signal?.aborted === true ? "the call was cancelled" : undefined;
			try {
				const result = await dispatchFleet({
					runId,
					assignments,
					runPi: getRunPi(),
					cancellations,
					progress,
					...(signal ? { signal } : {}),
				});
				const stopped = result.results.filter(
					(one) => one.state === "cancelled",
				);
				if (stopped.length > 0) {
					cutOff = `${count(stopped.length, "subagent")} was cancelled`;
				} else if (signal?.aborted === true) {
					cutOff = "the call was cancelled";
				}
				// Decorate the result with on-disk artifact paths so the full
				// per-subagent output is discoverable from the summary and the
				// details payload, not buried in the supervisor's state dir.
				const located = locateArtifacts(runs, result);
				return {
					content: [{ type: "text", text: formatFleetSummary(located) }],
					details: { ok: true, ...located },
				};
			} finally {
				// From a finally, because a failed fleet is handed back like
				// any other: the caller has the result and can go and look.
				// Settling only on the happy path would protect every failure
				// ever run, which is the unbounded population wearing a
				// different hat.
				//
				// Except where somebody was cut off. Cancellation is the
				// ending where an answer does not arrive: whatever that
				// subagent wrote is on disk and nowhere else, which is
				// precisely the population this ledger exists to keep, so
				// settling would release the protection at the one moment it
				// was doing its job.
				//
				// Both cancellations, and the second is the one that matters:
				// the signal is pi tearing the call away, and the registry is
				// somebody pressing a key in the panel, which is the only
				// cancellation this extension documents to anybody. That one
				// leaves the signal untouched and hands back a result with
				// cancelled entries in it, so a guard reading the signal
				// alone released every fleet a person actually stopped.
				if (cutOff !== undefined) {
					console.error(
						`[subagent-workflow] ${cutOff} in ${runId}, so its transcripts under ${join(runs, "runs")} are held rather than reclaimed. Delete ${join(fleets, `${safeSegment(runId)}.json`)} once you have read them or given up on them.`,
					);
				} else {
					await recordOrSay(
						() => ledger.settle(runId),
						`could not settle ${runId}, so whatever transcripts it left are held until its file under ${fleets} is cleared`,
					);
				}
			}
		},
	});
}
