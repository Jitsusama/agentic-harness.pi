/**
 * The mesh: the pi sessions on one machine as peers, coordinating in
 * shared groups without interrupting each other.
 *
 * Sessions working beside each other need to say things like "hold
 * heavy builds for twenty minutes" without typing into each other's
 * terminals, where a message lands in whatever the person is typing and
 * can answer a question left open on screen. So every peer sends
 * through a shared transport (lib/mesh/transport.ts), watches it, and
 * hands the model what reaches it.
 *
 * Into the conversation, not as a prompt. A message is something a peer
 * takes under advisement, so it never keeps a finished run going: pi
 * holds it while the agent works and appends it once the current step's
 * tool results are in, and appends it with no turn at all when the
 * session is idle. Delivered as a prompt instead, it stopped every
 * session it reached: an idle one started a turn about it, a busy one
 * picked it up as a new task at the moment it would have finished, and
 * each answered messages that needed no answer. The exceptions are what
 * an idle peer has to do something about: a question it is the one to
 * answer starts a turn at once, and a finding sent to it, or a question to a group
 * about its work, starts a turn once the mesh settles (see acts.ts).
 *
 * At the attention it bears, never none (lib/mesh/attention.ts), held
 * to what the peer can afford (lib/mesh/damping.ts). What concerns this
 * peer or the whole machine is noted in full. Another peer's own
 * business is a glance: shown on screen at once, and handed to the
 * model as one line with its next turn, whether that is the end of the
 * current step or the start of the next run.
 *
 * Every message goes to a group (lib/mesh/group.ts), never to a peer
 * alone, so what is said stays in a potentially shared space.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	getAgentDir,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { hosted, sessionEnv } from "../../lib/core/session/index.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { meshRefusal, sessionRealm } from "../../lib/internal/machine/realm.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import { doingFolder } from "../../lib/internal/quest/sessions/doing.ts";
import { carriedTrust } from "../../lib/internal/session/carried-trust.ts";
import { treeRecordDir } from "../../lib/internal/work-records.ts";
import { isSubagent } from "../../lib/mesh/hand.ts";
import { HOLD_TURNS, type HoldTurns } from "../../lib/mesh/lease.ts";
import { waitingFolder } from "../../lib/mesh/waiting.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
} from "../../lib/subagent/events.ts";
import { dropEmptyMessages } from "../../lib/ui/no-empty-messages.ts";
import { SETTLING, type Settling } from "./acts.ts";
import { holdSessionLog } from "./held-log.ts";
import { onBus } from "./peer/bus.ts";
import { registerCommands } from "./peer/commands.ts";
import { createHanding } from "./peer/handing.ts";
import { createHearing } from "./peer/hearing.ts";
import { watchHeavyWork } from "./peer/heavy.ts";
import { registerLocal } from "./peer/local.ts";
import { LOOK_AGAIN_MS, type MeshPaths, WAIT_CHECK_MS } from "./peer/mesh.ts";
import { onRuns } from "./peer/runs.ts";
import { onSessionStart } from "./peer/start.ts";
import { createState } from "./peer/state.ts";
import { createSteerer } from "./peer/steerer.ts";
import { createWaits } from "./peer/waits.ts";
import type { HubTiming } from "./tools/above.ts";

export {
	isEphemeral,
	LEFT_MS,
	LOOK_AGAIN_MS,
	MESH_CLASSIFIER_ENV,
	MESH_ENV,
	type MeshPaths,
	WAIT_CHECK_MS,
} from "./peer/mesh.ts";

/** The machine's mesh and the quest records it reads. */
export function machinePaths(): MeshPaths {
	return {
		mesh: stateDir("mesh-workflow"),
		steer: stateDir("steer"),
		waiting: waitingFolder(),
		looks: stateDir("looks"),
		sessions: join(stateDir("quest-workflow"), "sessions"),
		quests: join(dataDir("quest-workflow"), "quests"),
		doing: doingFolder(),
		trees: treeRecordDir(),
	};
}

/** The extension every subagent loads, as its parent's hands. */
export const HAND_EXTENSION = fileURLToPath(
	new URL("./hand.ts", import.meta.url),
);

/**
 * Have every subagent this pi starts load its hands, isolated ones
 * included. The fleet keeps the list, and either may load first: one
 * that loads after this hears the registration, and one that loaded
 * before it says it is ready.
 */
export function registerHands(events: ExtensionAPI["events"] | undefined) {
	if (!events) return;
	events.emit(SUBAGENT_REGISTER_DEFAULT_EXTENSION, HAND_EXTENSION);
	events.on(SUBAGENT_READY, (api) => {
		const register = (api as { registerDefaultExtension?: unknown } | null)
			?.registerDefaultExtension;
		if (typeof register === "function") register(HAND_EXTENSION);
	});
}

/** The extension, on the mesh at these paths. */
export function meshWorkflow(
	paths: MeshPaths = machinePaths(),
	env: NodeJS.ProcessEnv = hosted() ? sessionEnv().snapshot() : process.env,
	settling: Settling = SETTLING,
	waitCheckMs: number = WAIT_CHECK_MS,
	lookAgainMs: number = LOOK_AGAIN_MS,
	hubTiming: HubTiming = {},
	turns: HoldTurns = HOLD_TURNS,
) {
	return (pi: ExtensionAPI) => {
		// A conversation its host let go with its folder untrusted stays so
		// in the plain pi that takes it up, for that pi alone (carried-trust.ts).
		pi.on("project_trust", async (event) =>
			carriedTrust(event.cwd, {
				saved: (cwd) => new ProjectTrustStore(getAgentDir()).get(cwd),
			}) === "no"
				? { trusted: "no" as const, remember: false }
				: { trusted: "undecided" as const },
		);
		// Not a peer: a subagent is its parent's hands (see hand.ts).
		if (isSubagent(env)) return;
		// A delivery /mesh quiet hides draws nothing, and so takes no row.
		dropEmptyMessages();
		// A realm name no folder may carry would put this peer where no
		// node and no other session looks: say so, and stay off the mesh.
		const refused = meshRefusal(sessionRealm(env));
		if (refused !== undefined) {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.hasUI) ctx.ui.notify(refused, "warning");
			});
			return;
		}
		registerHands(pi.events);
		holdSessionLog(pi);
		declareGuards(GUARDS.meshEndHold, GUARDS.untestedCause);
		const m = createState(
			pi,
			paths,
			env,
			settling,
			waitCheckMs,
			lookAgainMs,
			hubTiming,
			turns,
		);
		const handing = createHanding(m);
		const waits = createWaits(m);
		const hearing = createHearing(m, handing);
		const steerer = createSteerer(m);
		registerCommands(m, handing);
		const heavy = watchHeavyWork(m);
		onSessionStart(m, {
			...waits,
			...handing,
			...steerer,
			...hearing,
			...heavy,
		});
		onRuns(m, { ...handing, ...hearing, ...heavy });
		onBus(m, handing);
		registerLocal(m, { ...waits, ...hearing });
	};
}

export default meshWorkflow();
