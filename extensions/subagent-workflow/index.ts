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
 *   prompt across N personas, asking for divergent
 *   answers. Same `userPrompt`, different `systemPrompt`,
 *   one model (lib/internal/session/asked-models.ts).
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fencedChildrenRefusal,
	settingsRefusal,
} from "../../lib/internal/fence/installed-only.ts";
import { stateDir as stateDirOf } from "../../lib/internal/paths.ts";
import { personsWords } from "../../lib/internal/session/asked-models.ts";
import { endsWithItsPrompts, runOrHandOff } from "../../lib/jobs/hand-off.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.ts";
import {
	getSubagentDefaults,
	registerSubagentDefaultExtension,
	registerSubagentDefaultSkill,
} from "../../lib/subagent/defaults.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
	SUBAGENT_REGISTER_DEFAULT_SKILL,
} from "../../lib/subagent/events.ts";
import { createFleetLedger } from "../../lib/subagent/fleet.ts";
import { getParentPiInstall } from "../../lib/subagent/install.ts";
import { watchRun } from "../../lib/subagent/run-record.ts";
import { createSupervisorRunPi } from "../../lib/subagent/runpi/supervisor.ts";
import { asideFor } from "../../lib/ui/aside.ts";
import { count } from "../../lib/ui/count.ts";
import { drawInto } from "../../lib/ui/tool-call.ts";
import {
	finishInBackground,
	startedAnswer,
	startFleetJob,
} from "./background.ts";
import { cameBack, ourOwner, recordOrSay, sessionOf } from "./bookkeeping.ts";
import {
	FleetCancellationRegistry,
	formatFleetCancellation,
} from "./cancellation.ts";
import { fleetHandOver, takesUpCarriedFleets } from "./carry.ts";
import {
	SUBAGENT_DESCRIPTION,
	SUBAGENT_GUIDELINES,
	SUBAGENT_PARAMETERS,
	SUBAGENT_PROMPT_SNIPPET,
} from "./declaration.ts";
import { childSandbox, fenceChildren, keepFence } from "./fence-keep.ts";
import { saidFirst, sizeFleet } from "./fleet-settings.ts";
import {
	createFleetProgressReporter,
	fleetCardLines,
	isFleetRunResult,
} from "./progress-render.ts";
import {
	buildAssignment,
	dispatchFleet,
	type FleetAssignment,
	formatFleetSummary,
	locateArtifacts,
} from "./run.ts";
import {
	FLEET_CUT_OFF_MESSAGE,
	stopOrphanedSubagents,
	sweepFleetRuns,
} from "./upkeep.ts";

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

export default function subagentWorkflow(pi: ExtensionAPI) {
	const stateDir = () => stateDirOf("subagent-workflow");
	// Beside the run directories rather than inside them: this is a
	// small file read at every session start, and those are megabytes
	// of event stream per subagent. The run id is the key on both
	// sides, so either points at the other without holding it.
	const fleetDir = () => join(stateDir(), "fleets");
	const cancellations = new FleetCancellationRegistry();
	// What the person typed, for a job naming a model only they may ask for.
	const person = personsWords();
	pi.on("input", (event) => {
		if (event.source === "interactive") person.heard(event.text);
	});
	// A background fleet a move carried here, said under its own job.
	takesUpCarriedFleets(pi.events);

	// Prune old fleet run directories at session start so the raw
	// artifacts they hold do not accumulate unbounded. A finished run
	// goes on the normal window; an unfinished one is kept far longer,
	// for recovery, but not forever.
	//
	// Both paths are resolved here, before anything is awaited. They
	// resolve against the environment each time they are called and
	// this runs unawaited, so a lookup after the first await is a
	// lookup against whatever the environment says by then.
	//
	// The look for orphans waits for the session to be ready, which is
	// once pi has asked for resources: it asks after every handler's
	// session start has answered, at every start and reload. It is the
	// machine's look rather than this session's, and on a wake on 15
	// November it took 1.3 s of the thread in the first 6.5 s, while
	// this session and its neighbours were still starting.
	let lookForOrphans: (() => Promise<void>) | undefined;
	pi.on("session_start", (_event, ctx) => {
		// Not returned. Nothing about reclaiming disk should delay a
		// session, and the sibling extension does the same: a handler
		// that awaits this makes every start wait on a directory walk.
		// One after the other, over one tree. Fired side by side, the
		// recovery walks directories the sweep is removing and writes
		// cancel sentinels back into ones it has already taken, which
		// recreates as a stub the very directory that was just reclaimed.
		const runs = stateDir();
		const fleets = fleetDir();
		// Through the session's screen, never straight to the terminal,
		// which pi is drawing (lib/ui/aside.ts).
		const say = asideFor(ctx);
		// Read before anything is awaited, like the paths: it is this
		// conversation's, and its own cut-off fleets are told to it.
		const session = sessionOf(ctx);
		const returned = cameBack(ctx);
		const swept = sweepFleetRuns(runs, fleets, say, {
			session,
			cameBack: returned,
			// With the next turn, whether or not one is running when the
			// sweep gets here: it is context for the model, not a prompt.
			tell: (content) =>
				pi.sendMessage(
					{ customType: FLEET_CUT_OFF_MESSAGE, content, display: false },
					{ deliverAs: "nextTurn" },
				),
		});
		// After the sweep, still: the two walk one tree.
		lookForOrphans = async () => {
			await swept;
			await stopOrphanedSubagents(runs, say);
		};
	});
	pi.on("resources_discover", () => {
		// Once per start, whatever else asks for resources later.
		const look = lookForOrphans;
		lookForOrphans = undefined;
		// pi draws the session once every handler here has answered, so
		// the next turn of the loop comes after it.
		if (look) setImmediate(() => void look());
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
	// Scoped to one run, so the keys on one fleet's board reach that fleet
	// and no other running beside it.
	const controls = (runId: string) => ({
		cancelSubagent: (subagentId: string) =>
			formatFleetCancellation(cancellations.cancel(runId, subagentId)),
		cancelAll: () => formatFleetCancellation(cancellations.cancel(runId)),
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
		// The largest declaration after review_offer, quest and work, wanted
		// only for a fleet: loaded on demand, and by reading the
		// subagent-fleet-guide skill, which names it.
		exposure: "deferred",
		label: "Subagent Fleet",
		description: SUBAGENT_DESCRIPTION,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_GUIDELINES,
		parameters: SUBAGENT_PARAMETERS,
		// The fleet as its board looked when it ended, so the card that
		// replaces the board opens with the same rows and is never shorter.
		renderResult(result, { expanded }, theme, context) {
			if (!context?.isError && isFleetRunResult(result.details)) {
				return drawInto(
					context?.lastComponent,
					fleetCardLines(result.details, theme, expanded).join("\n"),
				);
			}
			const first = result.content?.[0];
			const text = first?.type === "text" ? first.text : "";
			return drawInto(
				context?.lastComponent,
				context?.isError ? theme.fg("error", text) : text,
			);
		},
		async execute(toolCallId, params, toolSignal, _onUpdate, ctx) {
			const runId = params.runId ?? `fleet-${randomUUID()}`;
			const say = asideFor(ctx);
			// The conversation waiting on this fleet, so that if this process
			// ends under it, the same conversation hears when it comes back.
			const session = sessionOf(ctx);
			const sized = await sizeFleet(
				ctx,
				params.jobs,
				params.defaults,
				person.said,
			);
			if ("refusal" in sized) {
				return {
					content: [{ type: "text" as const, text: sized.refusal }],
					details: { ok: false },
				};
			}
			const sandbox = childSandbox();
			// Every child loads this package's own files and the registered
			// defaults outside the fence, and an unisolated one whatever the
			// person's settings name. That matters wherever the children are
			// fenced: a fenced child may write the tree it works in, and the
			// next child would load what it planted there, outside the fence,
			// even where this session's own commands run as the person.
			const unisolated = sized.jobs.some((job) => job.isolated === false);
			const outside =
				sandbox === undefined
					? undefined
					: (fencedChildrenRefusal(
							unisolated,
							getSubagentDefaults().extensions,
						) ?? (unisolated ? await settingsRefusal() : undefined));
			if (outside !== undefined) {
				return {
					content: [
						{ type: "text" as const, text: `No subagent started: ${outside}` },
					],
					details: { ok: false },
				};
			}
			const kept = keepFence(sized.jobs, sandbox);
			if (!kept.ok) {
				return {
					content: [{ type: "text" as const, text: kept.refusal }],
					details: { ok: false },
				};
			}
			// The extensions as followed, never as named, so a link swapped
			// since can't point a child elsewhere.
			const fenced = fenceChildren(kept.jobs.map(buildAssignment), sandbox);
			if (!fenced.ok) {
				return {
					content: [{ type: "text" as const, text: fenced.refusal }],
					details: { ok: false },
				};
			}
			const assignments: FleetAssignment[] = fenced.jobs;
			// Held apart, since the fleet below runs in a function of its own,
			// where the narrowing above does not reach.
			const ranOn = sized.ranOn;
			// How a move carries it on into a host, its subagents running on.
			const handover = fleetHandOver(
				{
					runId,
					members: assignments.map(({ spec }) => ({
						id: spec.id,
						...(spec.model === undefined ? {} : { model: spec.model }),
						...(spec.thinkingLevel === undefined
							? {}
							: { thinkingLevel: spec.thinkingLevel }),
					})),
					startedAt: Date.now(),
					runs: stateDir(),
					fleets: fleetDir(),
					ranOn,
				},
				session,
			);
			// In the background the fleet answers to its job, which the person
			// stops from /jobs and the session stops as it ends, and not to the
			// call, which returns at once.
			const job =
				params.background === true
					? startFleetJob(pi.events, runId, assignments.length, handover.carry)
					: undefined;
			const progress = createFleetProgressReporter(ctx, controls(runId), runId);
			if (job !== undefined) {
				finishInBackground(
					job,
					runFleet(handover.follow(job.signal)),
					progress,
					runId,
				);
				return saidFirst(ranOn, startedAnswer(job, runId, assignments.length));
			}
			// A fleet waited on holds its turn, deaf to the person and the
			// mesh, so one still running after a minute moves to a job, as a
			// long command does.
			return await runOrHandOff<unknown>({
				kind: "subagent",
				label: `${count(assignments.length, "subagent")} in ${runId}`,
				noun: "background fleet",
				filePrefix: "pi-fleet",
				stopping: (jobId) =>
					`To stop it, call the jobs tool's stop with ${jobId} (load it with tool_search); the person can stop it with /jobs or from its board.`,
				quiet: "Its board shows how far each subagent has got.",
				toolCallId,
				// Names the file a long result is kept in; the run's id is as
				// unique where no conversation is known.
				session: session ?? runId,
				nested: endsWithItsPrompts(ctx.mode),
				signal: toolSignal,
				onUpdate: undefined,
				bus: pi.events,
				carryOf: () => handover.carry,
				run: async (owned) => {
					// The board comes down after the bookkeeping below, not when
					// the fleet finishes: pi draws the result card in the frame
					// after the return, so the board leaving any earlier leaves
					// its rows blank for as long as the bookkeeping takes.
					try {
						return await runFleet(handover.follow(owned));
					} finally {
						progress.close();
					}
				},
			});

			async function runFleet(signal: AbortSignal) {
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
				await recordOrSay(
					async () => {
						// Asked inside the guard, since it forks a subprocess and
						// bookkeeping must not cost a fleet: outside it, a `ps`
						// that hung or threw took the dispatch with it.
						const owner = await ourOwner(session);
						await ledger.open({
							id: runId,
							startedAt: new Date().toISOString(),
							jobs: assignments.map((one) => one.spec.id),
							...(session ? { session } : {}),
							...(owner ? { owner } : {}),
						});
					},
					`could not write ${runId} down before dispatching it, so the sweep will not know to keep its transcripts`,
					say,
				);
				// Once for the run, before any of its jobs are prepared. A run
				// id comes round again whenever a caller supplies one, and the
				// supervisor stops the moment it sees a cancellation, so a run
				// stopped once would otherwise kill every later run under the
				// same name on arrival.
				await recordOrSay(
					() => new ReviewerArtifactsStore(runs).beginRun(runId),
					`could not clear an earlier cancellation of ${runId}, so its jobs may stop the moment they start`,
					say,
				);
				// Said in its run record while it goes on, for the launcher,
				// under the session waiting on it.
				const record =
					session === undefined
						? undefined
						: watchRun(
								{
									store: "fleet",
									artifacts: runs,
									runId,
									kind: "fleet",
									parent: session,
									about: runId,
									since: new Date(),
								},
								assignments.map(({ spec }) => ({
									id: spec.id,
									...(spec.model === undefined ? {} : { model: spec.model }),
								})),
							);
				// Whether anything was cut off before it could answer. Set
				// inside the try and read in the finally, because the finally
				// is the only place that sees both endings.
				let cutOff = signal?.aborted === true;
				try {
					const result = await dispatchFleet({
						runId,
						assignments,
						runPi: getRunPi(),
						cancellations,
						progress,
						recordRun: handover.recordRun,
						...(signal ? { signal } : {}),
					});
					const stopped = result.results.filter(
						(one) => one.state === "cancelled",
					);
					if (stopped.length > 0 || signal?.aborted === true) cutOff = true;
					// Decorate the result with on-disk artifact paths so the full
					// per-subagent output is discoverable from the summary and the
					// details payload, not buried in the supervisor's state dir.
					const located = locateArtifacts(runs, result);
					return {
						content: [
							{
								type: "text" as const,
								text: `${ranOn}\n\n${formatFleetSummary(located)}`,
							},
						],
						details: { ok: true, ...located },
					};
				} finally {
					// Handed on with its session, it ends where it went, which
					// keeps its run record and settles its ledger record there.
					if (!handover.handedOn()) await endHere();
				}
				async function endHere() {
					handover.ended();
					await record?.end();
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
					//
					// Recorded on the fleet rather than said. Somebody stopped it
					// in front of them, so there is nothing to tell, and the
					// record keeps the transcripts for the cut-off window and
					// then lets them go, with nobody asked to delete a file.
					if (cutOff) {
						await recordOrSay(
							() => ledger.cutOff(runId, "cancelled"),
							`could not record that ${runId} was cancelled, so its transcripts stay held as if it were still running`,
							say,
						);
					} else {
						await recordOrSay(
							() => ledger.settle(runId),
							`could not settle ${runId}, so whatever transcripts it left are held until its file under ${fleets} is cleared`,
							say,
						);
					}
				}
			}
		},
	});
}
