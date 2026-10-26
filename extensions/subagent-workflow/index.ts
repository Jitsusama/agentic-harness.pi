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
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { packageStateDir } from "../../lib/internal/package-state-dir.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.ts";
import {
	registerSubagentDefaultExtension,
	registerSubagentDefaultSkill,
} from "../../lib/subagent/defaults.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
	SUBAGENT_REGISTER_DEFAULT_SKILL,
} from "../../lib/subagent/events.ts";
import {
	abandonedFleets,
	createFleetLedger,
	type FleetLedger,
	type FleetRun,
	stillHeld,
	whoIsWaiting,
} from "../../lib/subagent/fleet.ts";
import { getParentPiInstall } from "../../lib/subagent/install.ts";
import { systemFacts } from "../../lib/subagent/lease.ts";
import { recoverReviewerRuns } from "../../lib/subagent/recovery.ts";
import { createSupervisorRunPi } from "../../lib/subagent/runpi/supervisor.ts";
import { THINKING_LEVELS } from "../../lib/thinking/index.ts";
import { type Aside, asideFor } from "../../lib/ui/aside.ts";
import { count } from "../../lib/ui/count.ts";
import { drawInto } from "../../lib/ui/tool-call.ts";
import {
	finishInBackground,
	startedAnswer,
	startFleetJob,
} from "./background.ts";
import {
	FleetCancellationRegistry,
	formatFleetCancellation,
} from "./cancellation.ts";
import { digestFleetRuns } from "./digests.ts";
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
// The same window keeps a cut-off fleet's transcripts, counted from
// when it was cut off: long enough for its conversation to come back
// and read them, and then it goes the way of any finished fleet.
const FLEET_RUNS_ABANDONED_AFTER_MS = 4 * FLEET_RUNS_MAX_AGE_MS;
/**
 * A note earlier versions kept of the abandoned fleets they had
 * named, removed wherever it is found.
 *
 * Rebuilt by every session start from what that session saw, so two
 * sessions starting together each wrote their own reading and the last
 * one won, which made a certain "gone" lose to an unsure one and the
 * same fleets get named again. Whether a fleet has been told now lives
 * on its own record.
 */
const ABANDONED_SAID_BEFORE = "abandoned-said.json";
/**
 * What a restored conversation is told about its own cut-off fleets.
 *
 * A message to the model rather than a notice to the screen. The
 * conversation that dispatched a fleet is the one place knowing it was
 * cut off is worth anything, since it knows what the fleet was for,
 * and every other session has no use for it at all.
 */
const FLEET_CUT_OFF_MESSAGE = "subagent-fleet-cut-off";
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
	say: Aside,
): Promise<void> {
	try {
		// Called here rather than taken as a started promise, so a
		// synchronous throw on the way in is caught by the guard it was
		// meant for rather than escaping past it.
		await work();
	} catch (error) {
		say(
			`[subagent-workflow] ${cost}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Who is waiting, asked once.
 *
 * The answer cannot change and asking costs a subprocess, so it is
 * kept; the library is left stateless, since a cache belongs to a
 * session rather than to a definition. A failure is not kept, because
 * `ps` can miss for a moment under load and caching that turns one
 * slow probe into a session where no fleet is attributed to anybody.
 */
async function ourOwner(): Promise<FleetRun["owner"]> {
	if (waiting !== undefined) return waiting;
	waiting = await whoIsWaiting(systemFacts);
	return waiting;
}

/** What {@link ourOwner} has settled on, once it has. */
let waiting: FleetRun["owner"] | undefined;

/**
 * The pi session this context belongs to, when it says.
 *
 * Guarded, since a context built by something other than pi need not
 * carry a session manager, and a fleet recorded without a session is
 * still a fleet recorded.
 */
function sessionOf(ctx: { sessionManager?: unknown }): string | undefined {
	try {
		const manager = ctx.sessionManager as
			| { getSessionId?: () => string | undefined }
			| undefined;
		return manager?.getSessionId?.() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Tell this conversation about the fleets it dispatched that were cut
 * off when it last ended, once each.
 *
 * Only a conversation that has come back can match, since a fleet is
 * cut off for its session ending, so in every other session this says
 * nothing. Told before the record is marked, so a mark that fails costs
 * telling it once more rather than never.
 */
async function tellOwnCutOffs(
	held: readonly FleetRun[],
	runs: string,
	ledger: FleetLedger,
	conversation: Conversation,
	say: Aside,
): Promise<void> {
	const { session, tell } = conversation;
	if (session === undefined) return;
	const store = new ReviewerArtifactsStore(runs);
	for (const run of held) {
		const cut = run.cutOff;
		if (run.session !== session || cut?.why !== "owner-gone" || cut.told) {
			continue;
		}
		const dir = store.rootPaths(run.id).runDir;
		const until = new Date(Date.parse(cut.at) + FLEET_RUNS_ABANDONED_AFTER_MS)
			.toISOString()
			.slice(0, 10);
		const kept = (await exists(dir))
			? `What its subagents wrote is under ${dir}, kept until ${until}.`
			: "Nothing its subagents wrote was kept.";
		tell(
			`The subagent fleet ${run.id} (${run.jobs.join(", ")}), dispatched from this conversation at ${run.startedAt}, was cut off when this session last ended, so its answers never came back. ${kept} If its work still matters, read what it left or dispatch it again.`,
		);
		await recordOrSay(
			() => ledger.told(run.id),
			`could not note that ${run.id} was told, so it may be told again`,
			say,
		);
	}
}

/** Whether a path is there at all. */
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		// Gone, or unreachable. Both mean there is nothing to send
		// somebody to go and read.
		return false;
	}
}

/**
 * Stop a subagent whose supervisor died, and say what happened to it.
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
async function stopOrphanedSubagents(runs: string, say: Aside): Promise<void> {
	try {
		const { reaped, stale, warnings } = await recoverReviewerRuns(
			new ReviewerArtifactsStore(runs),
		);
		// Said out loud, and both halves of it. A session that quietly
		// interferes with processes it finds running is worse than one
		// that leaves them, and whoever is paying for those tokens should
		// hear that they stopped.
		//
		// Stale is the larger set: every one of those was asked to stop,
		// and only the ones whose lease named a process that is
		// identifiably still there could be killed as well. Reporting the
		// killable subset alone would say nothing at all about the run
		// whose child had already gone, which is the ordinary case.
		//
		// Said once, which the recovery decides rather than this: the
		// runs it names are the ones nobody had asked before, since
		// nothing empties this population and the same line would
		// otherwise be printed at every session start forever.
		if (stale.length > 0) {
			say(
				`[subagent-workflow] asked ${count(stale.length, "subagent")} whose supervisor had died to stop${reaped.length > 0 ? `, and killed ${count(reaped.length, "child", "children")} still holding on` : ""}: ${stale
					.map((one) => `${one.runId}/${one.reviewerId}`)
					.join(", ")}`,
			);
		}
		// Capped for the reason the sweep's are: what produces these is
		// rarely one run.
		for (const warning of warnings.slice(0, MOST_WARNINGS)) {
			say(`[subagent-workflow] orphaned subagents: ${warning}`);
		}
	} catch (error) {
		// Advisory, like the sweep beside it: a session that cannot
		// check for orphans is still a session.
		say(
			`[subagent-workflow] could not look for orphaned subagents: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** The conversation a session start belongs to, and how to tell it. */
interface Conversation {
	/** Its pi session id, when pi says. */
	readonly session: string | undefined;
	/** Tell the model in it something, out of the person's way. */
	readonly tell: (content: string) => void;
}

/**
 * Give back the disk that finished fleets are still holding.
 *
 * Its own function rather than an event handler body, because it is
 * four policies in a row and a handler should say which ones rather
 * than be them.
 */
async function sweepFleetRuns(
	runs: string,
	fleets: string,
	say: Aside,
	conversation: Conversation,
): Promise<void> {
	const transcripts = join(runs, "runs");
	const ledger = createFleetLedger(fleets);
	try {
		const before = await ledger.everyFleet();
		const { unreadable } = before;
		if (unreadable.length > 0) {
			// Declined rather than swept with an empty protect set. An
			// empty set is not the cautious reading of a ledger that will
			// not open: a fleet's transcripts are the only copy of what it
			// said, so sweeping without knowing which are spoken for
			// deletes exactly the work this protects.
			say(
				`[subagent-workflow] fleet runs will not be swept while ${unreadable.join(", ")} cannot be read, because nothing can then say which fleets nobody has collected. Nothing repairs those files on their own, so this holds for every session until they are fixed or moved aside.`,
			);
			return;
		}
		// Cut off every open fleet whose session has provably gone, on its
		// record, once. Only a decisive "gone" counts: a reading the
		// machine would not settle changes nothing, so it can never undo
		// what another session already proved.
		for (const run of await abandonedFleets(before.runs, systemFacts)) {
			await recordOrSay(
				() => ledger.cutOff(run.id, "owner-gone"),
				`could not record that ${run.id} was cut off when its session ended, so it stays held as open`,
				say,
			);
		}
		// One walk after those writes, answering every question below. Two
		// reads inside one handler can disagree, and the pair that
		// disagrees is a protect set that kept a run beside a listing that
		// no longer mentions it.
		const { runs: held } = await ledger.everyFleet();
		const kept = stillHeld(
			held,
			new Date(Date.now() - FLEET_RUNS_ABANDONED_AFTER_MS),
		);
		// Digest before sweeping. The sweep is right that whole streams
		// cost too much disk to keep, and wrong that they are only needed
		// while a run is live: they are the only record of what fleet
		// spend bought. A digest is under one percent of a stream and
		// keeps every turn's usage, so the bytes can go and the index stay.
		const digested = await digestFleetRuns(transcripts, join(runs, "digests"));
		// A run that could not be digested is spared, since its stream is
		// still the only copy: nothing is swept that was not first captured.
		const protect = new Set([...kept, ...digested.failed]);
		if (digested.failed.size > 0) {
			say(
				`[subagent-workflow] kept ${count(digested.failed.size, "fleet")} back from the sweep because ${digested.failed.size === 1 ? "its stream" : "their streams"} could not be digested, and a stream is the only copy of what a subagent did: ${[...digested.failed].join(", ")}`,
			);
		}
		const swept = await new ReviewerArtifactsStore(runs).cleanupTerminalRuns({
			maxRuns: FLEET_RUNS_RETAIN,
			maxAgeMs: FLEET_RUNS_MAX_AGE_MS,
			abandonedAfterMs: FLEET_RUNS_ABANDONED_AFTER_MS,
			protect,
		});
		// Nobody else is told anything about held or cut-off fleets. A
		// fleet another session is running is that session's business, and
		// a cut-off one is worth a word only to the conversation that
		// dispatched it, which hears below when it comes back.
		await rm(join(runs, ABANDONED_SAID_BEFORE), { force: true }).catch(
			() => undefined,
		);
		await tellOwnCutOffs(held, runs, ledger, conversation, say);
		// Capped, because what produces these is rarely one run: a
		// permissions change lands on all of them at once.
		for (const warning of swept.warnings.slice(0, MOST_WARNINGS)) {
			say(`[subagent-workflow] fleet runs: ${warning}`);
		}
		if (swept.warnings.length > MOST_WARNINGS) {
			say(
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
		say(
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
		void (async () => {
			await sweepFleetRuns(runs, fleets, say, {
				session,
				// With the next turn, whether or not one is running when the
				// sweep gets here: it is context for the model, not a prompt.
				tell: (content) =>
					pi.sendMessage(
						{ customType: FLEET_CUT_OFF_MESSAGE, content, display: false },
						{ deliverAs: "nextTurn" },
					),
			});
			await stopOrphanedSubagents(runs, say);
		})();
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
		// Called in 22 of 68 sessions from 18 October, and the
		// subagent-fleet-guide skill names it, so it loads when that is read.
		exposure: "deferred",
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
		promptGuidelines: [
			"Size a fleet to the angles it needs: one job per angle the others do not cover. A fleet past subagent.maxJobs (8 by default) is refused; do not split it into two calls to get under the cap.",
			"Leave model and thinkingLevel off a job unless it needs something different from the rest. They are filled, first match winning, from the run's defaults, the loaded quest's and the project's subagent settings, subagent.defaults, then the session's own model at high thinking; the answer says what each job ran on.",
		],
		parameters: Type.Object({
			jobs: Type.Array(
				Type.Object({
					id: Type.String({
						description:
							"Stable id for this subagent, shown on the board and naming its artifacts.",
						pattern: "^[a-zA-Z0-9._-]+$",
					}),
					model: Type.Optional(
						Type.String({
							description:
								"provider/model or a bare model id. Omit to take the run's defaults, then the configured settings, then the session's model.",
						}),
					),
					thinkingLevel: Type.Optional(
						StringEnum(
							// The shared list, so this schema and the one the review
							// tools offer cannot come to disagree about what pi takes.
							THINKING_LEVELS,
							{
								description:
									"Omit to take the same layers as model, and otherwise high.",
							},
						),
					),
					tools: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Tool palette, e.g. [read,bash]. Omit for the default.",
						}),
					),
					cwd: Type.String({
						description:
							"Working directory: the project root, or a worktree for detached work.",
					}),
					systemPrompt: Type.Optional(
						Type.String({
							description: "Persona instructions, for role-based fan-outs.",
						}),
					),
					userPrompt: Type.String({
						description:
							"What the subagent answers, phrased as you would ask a teammate.",
					}),
					isolated: Type.Optional(
						Type.Boolean({
							description:
								"Defaults to true: the subagent sees only what you attach, not your skills, context files or extensions.",
						}),
					),
					extraExtensions: Type.Optional(
						Type.Array(Type.String(), {
							description: "Absolute extension paths to load.",
						}),
					),
					extraSkills: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Absolute skill paths to load, e.g. an output contract.",
						}),
					),
					timeoutMs: Type.Optional(
						Type.Integer({
							minimum: 1000,
							maximum: 8 * 60 * 60 * 1000,
							description:
								"Wall-clock limit for this job, for work that runs long. At most eight hours.",
						}),
					),
					idleTimeoutMs: Type.Optional(
						Type.Integer({
							minimum: 1000,
							maximum: 8 * 60 * 60 * 1000,
							description:
								"How long the job may be silent before it counts as stuck. Raise it, and timeoutMs with it, for long quiet commands such as cloud deletes or benchmarks.",
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
									"Verify pack: the subagent must pass verify_output before its run is accepted.",
							},
						),
					),
				}),
				{
					description:
						"Jobs to run at once, one pi process each, answered in order.",
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
						"Stable id for this run, naming its artifacts. Generated when omitted.",
				}),
			),
			defaults: Type.Optional(
				Type.Object(
					{
						model: Type.Optional(Type.String()),
						thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
						tools: Type.Optional(Type.Array(Type.String())),
						timeoutMs: Type.Optional(Type.Integer()),
						idleTimeoutMs: Type.Optional(Type.Integer()),
					},
					{
						description:
							"Settings for every job in this run that does not set its own: model, thinkingLevel, tools and the two clocks. They come before the quest's, the project's and the config's subagent settings, and the session's model.",
					},
				),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Return at once and let the fleet run on; its summary arrives later as its own message, so carry on rather than poll.",
				}),
			),
		}),
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
		async execute(_toolCallId, params, toolSignal, _onUpdate, ctx) {
			const runId = params.runId ?? `fleet-${randomUUID()}`;
			const say = asideFor(ctx);
			// The conversation waiting on this fleet, so that if this process
			// ends under it, the same conversation hears when it comes back.
			const session = sessionOf(ctx);
			const sized = await sizeFleet(ctx, params.jobs, params.defaults);
			if ("refusal" in sized) {
				return {
					content: [{ type: "text" as const, text: sized.refusal }],
					details: { ok: false },
				};
			}
			const assignments: FleetAssignment[] = sized.jobs.map(buildAssignment);
			// Held apart, since the fleet below runs in a function of its own,
			// where the narrowing above does not reach.
			const ranOn = sized.ranOn;
			// In the background the fleet answers to its job, which the person
			// stops from /jobs and the session stops as it ends, and not to the
			// call, which returns at once.
			const job =
				params.background === true
					? startFleetJob(pi.events, runId, assignments.length)
					: undefined;
			const signal = job?.signal ?? toolSignal;
			const progress = createFleetProgressReporter(ctx, controls(runId), runId);
			if (job !== undefined) {
				finishInBackground(job, runFleet(), progress, runId);
				return saidFirst(ranOn, startedAnswer(job, runId, assignments.length));
			}
			// The board comes down as the tool returns, after the bookkeeping
			// below, and not when the fleet finishes: pi draws the result card
			// in the frame after the return, so the board leaving any earlier
			// leaves its rows blank for as long as the bookkeeping takes.
			try {
				return await runFleet();
			} finally {
				progress.close();
			}

			async function runFleet() {
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
						const owner = await ourOwner();
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
