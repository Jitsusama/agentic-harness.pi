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

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	type FoundClassifier,
	findClassifier,
} from "../../lib/classifier/jev.ts";
import { resolveReference } from "../../lib/core/review/index.ts";
import {
	hosted,
	sessionCwd,
	sessionEnv,
	sessionKeyOf,
	sessionOwner,
} from "../../lib/core/session/index.ts";
import { endConversation } from "../../lib/core/session/owner.ts";
import { stoppingFromOutside } from "../../lib/internal/away/state.ts";
import { machineBooted } from "../../lib/internal/booted.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { dataDir, everyRealmsDir, stateDir } from "../../lib/internal/paths.ts";
import { tellAwaited } from "../../lib/internal/priority/awaited.ts";
import { whereItRuns } from "../../lib/internal/priority/send.ts";
import { onConcluded } from "../../lib/internal/quest/concluded.ts";
import { withQuestLock } from "../../lib/internal/quest/io.ts";
import { meshRefusal, sessionRealm } from "../../lib/internal/realm.ts";
import {
	createReloadHold,
	HOLD_FOR_RELOAD_MS,
	oweTurnToReload,
	takeOwedTurn,
} from "../../lib/internal/reload/hold.ts";
import { SANDBOX_VARIABLE, STRICT } from "../../lib/internal/sandbox.ts";
import { carriedEnvironment } from "../../lib/internal/session/carried-environment.ts";
import { contextUsageOf } from "../../lib/internal/session/context-usage.ts";
import {
	isPersonText,
	isPersonWords,
} from "../../lib/internal/session/driven.ts";
import {
	firstPromptPending,
	runStarted,
} from "../../lib/internal/session/first-prompt.ts";
import {
	type Landing,
	namesLanding,
	onClosed,
	onLanded,
	onUnlanded,
	withoutLanding,
} from "../../lib/internal/session/landings.ts";
import { sessionLeft } from "../../lib/internal/session/left.ts";
import {
	isMoveTarget,
	writeMoveNote,
} from "../../lib/internal/session/move.ts";
import {
	type NoModelEvent,
	onNoModel,
} from "../../lib/internal/session/no-model.ts";
import {
	askWake,
	isParkAsk,
	isParked,
	isParking,
	isRestartAsk,
	PARK_ASK,
	PARKING,
	RESTART_ASK,
	type RestartAsk,
	SESSION_WOKEN,
} from "../../lib/internal/session/park.ts";
import {
	carriedBy,
	ROLLOVER_CARRY,
} from "../../lib/internal/session/rollover.ts";
import { isWakersAsk, WAKERS_ASK } from "../../lib/internal/session/wakers.ts";
import { onWants, showWants } from "../../lib/internal/session/wants.ts";
import { writerHold } from "../../lib/internal/session/writer-hold.ts";
import { onJobFinished } from "../../lib/jobs/host.ts";
import { loadedQuest, type QuestRecords } from "../../lib/mesh/address.ts";
import {
	attend,
	type Concern,
	concernFrom,
	concernQuestionFor,
	concernState,
	FYI_MS,
	type Heed,
	mentions,
	type Receiver,
} from "../../lib/mesh/attention.ts";
import { type Crossings, cross } from "../../lib/mesh/crossing.ts";
import {
	caughtUp,
	createDamper,
	MOST_CAUGHT_UP,
} from "../../lib/mesh/damping.ts";
import { crossAt, flowsAt } from "../../lib/mesh/flow.ts";
import { groupNamed, homeOf, isJoinable } from "../../lib/mesh/group.ts";
import { isSubagent, MESH_SESSION_ENV } from "../../lib/mesh/hand.ts";
import { releaseThroughHost } from "../../lib/mesh/host-close.ts";
import { landingKeeper } from "../../lib/mesh/landing-history.ts";
import {
	awaitedSessions,
	carryLeases,
	changesOf,
	createBoard,
	isCurrent,
	LEASE_EVENT,
	type LeaseEvent,
	leaseEventFrom,
	type OwnLeases,
	ownerOf,
	ownLeases,
	RUN_KINDS,
} from "../../lib/mesh/lease.ts";
import { census } from "../../lib/mesh/liveness.ts";
import {
	type LookResolution,
	looksIn,
	resolveLooks,
	resolveLooksOfQuests,
} from "../../lib/mesh/looks.ts";
import {
	ASK_EVERY_MS,
	askable,
	markResolved,
	queryFor,
	resolutionsFrom,
	takeTurnToAsk,
} from "../../lib/mesh/looks-github.ts";
import {
	askableElsewhere,
	type HostedState,
	resolutionsElsewhere,
} from "../../lib/mesh/looks-hosted.ts";
import {
	asksEach,
	clock,
	isHomeTo,
	type Message,
	reaches,
	senderIdentity,
	shortId,
} from "../../lib/mesh/message.ts";
import { agentsAt, nodeSocket } from "../../lib/mesh/node.ts";
import {
	ASK_AGAIN_MS,
	createAwaiting,
	createOwing,
} from "../../lib/mesh/owed.ts";
import { wakeParked, wakeSteered } from "../../lib/mesh/parked.ts";
import { localPeer, type Peer } from "../../lib/mesh/peer.ts";
import {
	createPresences,
	type Presence,
	questEnded,
	windowTitle,
} from "../../lib/mesh/presence.ts";
import { keepPresent, whenPresent } from "../../lib/mesh/present.ts";
import { createReadFront } from "../../lib/mesh/reading.ts";
import { sweeper } from "../../lib/mesh/retention.ts";
import type { Judge } from "../../lib/mesh/routing.ts";
import { inboxOf, type Steer } from "../../lib/mesh/steer.ts";
import { toolDetail } from "../../lib/mesh/step.ts";
import { isStopped } from "../../lib/mesh/stop.ts";
import {
	answers,
	answersQuestion,
	depthOf,
	mayReplace,
	type Self,
	sentBy,
} from "../../lib/mesh/thread.ts";
import { toldIn } from "../../lib/mesh/told.ts";
import { folderTransport, type Transport } from "../../lib/mesh/transport.ts";
import { UNANSWERED_WITHIN_MS } from "../../lib/mesh/unanswered.ts";
import {
	localDay,
	noUsage,
	usageFromLog,
	withCall,
} from "../../lib/mesh/usage.ts";
import { waitingFolder, waitingOf } from "../../lib/mesh/waiting.ts";
import { type Want, type WantKind, wantFrom } from "../../lib/mesh/want.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
} from "../../lib/subagent/events.ts";
import { identifyCurrentTerminal } from "../../lib/terminal/resolve.ts";
import type { TerminalSessionHandle } from "../../lib/terminal/types.ts";
import { expandable } from "../../lib/ui/expandable.ts";
import { dropEmptyMessages } from "../../lib/ui/no-empty-messages.ts";
import { type Acts, createActs, SETTLING, type Settling } from "./acts.ts";
import { carryThisSession } from "./carrying.ts";
import {
	type Delivered,
	digest,
	GLANCE,
	GLANCES,
	holdsOver,
	NOTED,
	noted,
} from "./delivery.ts";
import { confirmEnd } from "./end-hold.ts";
import {
	createGlances,
	type Entry,
	handedIn,
	leftToIn,
	saidIn,
} from "./glances.ts";
import { moveIntoHost, probeHost, startTakeUp } from "./host-command.ts";
import { handOverOf, hostedPresence } from "./in-place.ts";
import {
	createEditNotes,
	createHeavyCalls,
	createLeasing,
	type HoldEnd,
	parkHeavyCalls,
	queueJobs,
	queueKept,
	reloading,
	takeHeavyCalls,
} from "./leases.ts";
import { createMoving, holdsOf, moveNoteOf } from "./moving.ts";
import { createPausing, RESUMED_TEXT } from "./pausing.ts";
import {
	type Folding,
	folds,
	keptOffIn,
	QUIET,
	QUIET_STATUS,
	quietIn,
	quietSaid,
	quietStatus,
	quietWanted,
} from "./quiet.ts";
import { meshLines, type Shown } from "./render.ts";
import {
	answerLookSteered,
	answerSteered,
	createSteering,
	LOOK_GONE,
	type Steering,
	steerText,
} from "./steer.ts";
import {
	assistantText,
	createTalks,
	ended,
	endsForGood,
	userText,
} from "./talks.ts";
import { tellOnNoModel, tellOrchestrator } from "./tells.ts";
import { type Local, registerTools } from "./tools.ts";
import {
	markOwnerRunning,
	settledText,
	settleFromVerdicts,
	type Waiting,
	watchSettling,
} from "./wait.ts";
import { meshWakers, type Own } from "./wakers.ts";

/**
 * The environment variable naming the classifier that judges messages
 * as `provider/model`, or `off` to note everything.
 */
export const MESH_CLASSIFIER_ENV = "PI_MESH_CLASSIFIER";

/**
 * The environment variable that keeps a session off the mesh when
 * `off`: it joins no group, hears nothing and claims nothing, as a
 * session kept nowhere does. A session on a small personal plan uses
 * it, since every hold and question on the machine could otherwise
 * start a turn on that plan's allowance.
 */
export const MESH_ENV = "PI_MESH";

/**
 * How long a classifier may take over one message before it is noted
 * unjudged. Jev answers in well under half a second; this is for the
 * network having gone, which must not leave a message undelivered.
 */
const JUDGE_MS = 2500;

/**
 * What starts the turn a note put off for a reload, when no reload came
 * to start it.
 */
const TURN_PUT_OFF =
	"The mesh messages above reached you while a reload of your harness waited. Act on them now.";

/** What starts the turn of a session woken from parking with messages waiting. */
const WOKEN_TO_READ =
	"Woken from parking. The mesh messages above reached you since your last turn and nothing has acted on them yet: read them and act on what is yours.";

/**
 * How many mesh notes came after the newest answer of the model on this
 * branch: handed over, and read by no turn yet.
 */
function handedSinceLastTurn(branch: readonly unknown[]): number {
	let handed = 0;
	for (let at = branch.length - 1; at >= 0; at -= 1) {
		const entry = branch[at];
		if (typeof entry !== "object" || entry === null) continue;
		if ("message" in entry && isAssistant(entry.message)) break;
		if ("customType" in entry && entry.customType === NOTED) handed += 1;
	}
	return handed;
}

function isAssistant(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "assistant"
	);
}

/** Whether `sender` is a session `addresses` orchestrate, as its presence says. */
function ledBy(
	sender: Pick<Presence, "orchestratedBy"> | undefined,
	addresses: readonly string[],
): boolean {
	return (
		sender?.orchestratedBy !== undefined &&
		addresses.includes(sender.orchestratedBy)
	);
}

/**
 * How far back a peer that has never read anything catches up.
 *
 * An hour rather than everything: what was said before then was said
 * to peers that were there, and a new one handed a day of other peers'
 * coordination has nothing to do with it but read it.
 */
const FIRST_CATCH_UP_MS = 60 * 60 * 1000;

/**
 * How often a peer waiting on another's hold asks whether its holder is
 * still there, or the hold has run out. Only while it waits: a peer
 * waiting on nothing keeps no clock.
 */
export const WAIT_CHECK_MS = 60 * 1000;

/**
 * How often a peer looks in the folder for messages its watcher never
 * reported. The kernel drops events when its queue fills, and a watcher
 * can die with the folder under it; either leaves a peer deaf with
 * nothing to show it. Aquifer's sessions keep a fallback poll for the
 * same reason. A look is one listing, so a minute costs nothing.
 */
export const LOOK_AGAIN_MS = 60 * 1000;

/**
 * How long a question left to the peer answering it is watched for that
 * peer letting it go. A question unanswered past an hour is news nobody
 * is waiting on any more, as an fyi is (see attention.ts).
 */
export const LEFT_MS = FYI_MS;

/**
 * How long after a session starts it first takes its steer inboxes.
 * Pi refuses a second turn beside the first prompt, so what waited
 * through a restart is taken once that prompt is under way, as a steer
 * into its run, or as a turn of its own when there was none.
 */
const FIRST_STEER_MS = 3000;

/** Why a stopped peer's message is a glance, whatever it was. */
const STOPPED = "from a peer this one stopped";

/** Where the mesh and the quest records live; the defaults are the machine's. */
export interface MeshPaths extends QuestRecords {
	/** The mesh's own state: its messages and every peer's presence. */
	readonly mesh: string;
	/** The person's steer inboxes (lib/mesh/steer.ts); none, none watched. */
	readonly steer?: string;
	/**
	 * What each quest has waiting on the person, where the launcher reads
	 * it (lib/mesh/waiting.ts); none, and mesh_wait keeps nothing.
	 */
	readonly waiting?: string;
	/**
	 * What sessions point the person at to look at, where the launcher's
	 * look list reads it (lib/mesh/looks.ts); none, and show_person keeps
	 * nothing.
	 */
	readonly looks?: string;
}

/**
 * Put the person's words in the prompt, unsent, for them to read and
 * send: what a to-do's drawer fills when it brings this session forward.
 * A prompt they were already typing in is left as it is, and the words
 * shown beside it, so nothing of theirs is lost.
 */
function fillPrompt(ctx: ExtensionContext | undefined, text: string): void {
	if (!ctx?.hasUI) return;
	if (ctx.ui.getEditorText().trim() === "") {
		ctx.ui.setEditorText(text);
		return;
	}
	ctx.ui.notify(
		`Your prompt already has words in it, so this was left out of it: ${text}`,
		"info",
	);
}

/** How often a session looks whether it's its turn to ask GitHub about looks. */
const LOOKS_CHECK_MS = 60_000;

/** How long one ask of GitHub about looks may take. */
const LOOKS_ASK_TIMEOUT_MS = 30_000;

/**
 * Ask the hosts of the changes the person's waiting looks point at about
 * them, when it's this session's turn, and mark what merged, closed or
 * got their review resolved: GitHub in one query, and every other host
 * through the review provider that claims the look's URL. A host that
 * can't be asked now leaves its looks waiting for the next turn.
 */
async function askAboutLooks(
	pi: Pick<ExtensionAPI, "exec">,
	dir: string,
	session: string,
): Promise<void> {
	try {
		const looks = looksIn(dir);
		const now = Date.now();
		const asked = askable(looks);
		const elsewhere = askableElsewhere(looks, Math.floor(now / ASK_EVERY_MS));
		if (asked.length === 0 && elsewhere.length === 0) return;
		if (!takeTurnToAsk(dir, session, now)) return;
		await Promise.all([
			askGitHubAboutLooks(pi, dir, asked),
			askHostsAboutLooks(dir, elsewhere),
		]);
	} catch {
		// The looks unreadable now: asked again next turn.
	}
}

/** Ask GitHub, in one query, about the looks at its pull requests. */
async function askGitHubAboutLooks(
	pi: Pick<ExtensionAPI, "exec">,
	dir: string,
	asked: ReturnType<typeof askable>,
): Promise<void> {
	if (asked.length === 0) return;
	try {
		const ran = await pi.exec(
			"gh",
			[
				"api",
				"graphql",
				"-f",
				`query=${queryFor(asked.map((one) => one.pull))}`,
			],
			{ timeout: LOOKS_ASK_TIMEOUT_MS },
		);
		// Not on its exit: one pull request GitHub can't find (deleted, or
		// a repo now private) makes gh exit 1 with the others' answers still
		// in its data, as a live ask on 8 November showed.
		if (ran.stdout.trim() === "") return;
		markResolved(dir, resolutionsFrom(asked, JSON.parse(ran.stdout)));
	} catch {
		// GitHub unreachable or its answer unreadable: asked again next turn.
	}
}

/** Ask each other host, through its review provider, about the looks at its changes. */
async function askHostsAboutLooks(
	dir: string,
	asked: ReturnType<typeof askableElsewhere>,
): Promise<void> {
	if (asked.length === 0) return;
	try {
		markResolved(dir, await resolutionsElsewhere(asked, hostedStateOf));
	} catch {
		// The looks unwritable now: asked again next turn.
	}
}

/**
 * Where a change stands on the host whose review provider claims its
 * URL, or none when no provider claims it. A host slower than
 * {@link LOOKS_ASK_TIMEOUT_MS} counts as unanswered.
 */
async function hostedStateOf(change: string): Promise<HostedState | undefined> {
	const found = resolveReference(change);
	if (!found.resolved || !found.provider.changes) return undefined;
	const fetched = found.provider.changes.fetch(found.change);
	const late = new Promise<undefined>((settle) => {
		setTimeout(() => settle(undefined), LOOKS_ASK_TIMEOUT_MS).unref();
	});
	return (await Promise.race([fetched, late]))?.state;
}

/**
 * Mark the person's waiting looks for a quest that `ended` says has
 * ended resolved, so nothing it asked of him outlives it (Joel, 11
 * November: "if it is no longer applicable ... it should disappear").
 * A look list that can't be written now is tried again on the next tick.
 */
function endLooksOfQuests(
	dir: string | undefined,
	ended: (quest: string) => boolean,
): void {
	if (!dir) return;
	try {
		resolveLooksOfQuests(dir, ended);
	} catch {
		// The looks stay waiting until the next tick.
	}
}

/**
 * Mark the person's looks at a change that merged or closed resolved, so
 * nothing asks them to look at what no longer needs them (Joel, 8
 * November). A look list that can't be written now keeps them waiting.
 */
function resolveLooksAt(
	dir: string | undefined,
	url: string,
	how: LookResolution,
): void {
	if (!dir) return;
	try {
		resolveLooks(dir, url, how);
	} catch {
		// The looks stay waiting, for the person to clear by hand.
	}
}

/** The machine's mesh and the quest records it reads. */
export function machinePaths(): MeshPaths {
	return {
		mesh: stateDir("mesh-workflow"),
		steer: stateDir("steer"),
		waiting: waitingFolder(),
		looks: stateDir("looks"),
		sessions: join(stateDir("quest-workflow"), "sessions"),
		quests: join(dataDir("quest-workflow"), "quests"),
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

/**
 * Whether this pi keeps no session, as a load check or a `--no-session`
 * run does. It is gone when it exits and nobody can reach it again, so
 * on the mesh it would only be a peer that never answers.
 */
export function isEphemeral(
	sessions: Pick<ExtensionContext["sessionManager"], "getSessionFile">,
): boolean {
	return (
		typeof sessions.getSessionFile === "function" &&
		sessions.getSessionFile() === undefined
	);
}

/** The extension, on the mesh at these paths. */
export function meshWorkflow(
	paths: MeshPaths = machinePaths(),
	env: NodeJS.ProcessEnv = hosted() ? sessionEnv().snapshot() : process.env,
	settling: Settling = SETTLING,
	waitCheckMs: number = WAIT_CHECK_MS,
	lookAgainMs: number = LOOK_AGAIN_MS,
) {
	return (pi: ExtensionAPI) => {
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
		declareGuards(GUARDS.meshEndHold);
		const transport: Transport = folderTransport(join(paths.mesh, "messages"));
		const presences = createPresences(join(paths.mesh, "presence"));
		const glances = createGlances();
		const damper = createDamper();
		const board = createBoard(join(paths.mesh, "leases"));
		const crossings: Crossings = {
			others: () =>
				everyRealmsDir("state", "mesh-workflow")
					.filter((dir) => dir !== paths.mesh && existsSync(dir))
					.map((dir) => ({
						dir,
						transport: folderTransport(join(dir, "messages")),
					})),
			notes: join(paths.mesh, "crossings"),
			...senderIdentity(),
		};
		// Lets go of what is past its time, at most hourly, off the turn.
		const tidy = sweeper({
			transport,
			presences,
			board,
			...(paths.steer !== undefined ? { inboxes: paths.steer } : {}),
		});
		let own: OwnLeases | undefined;
		// Heavy work that ended before this runtime had its leases to release.
		const unowned: LeaseEvent[] = [];
		const leasing = createLeasing({
			board,
			presences,
			transport,
			own: () => own,
			peer: () => peer,
			sent: (message) => seen.add(message.id),
			queueKept: () => queueKept(env),
			booted: () => machineBooted(),
			told: toldIn(join(paths.mesh, "told")),
		});
		// The sessions last counted still there, so a quest's address is
		// left only to a peer that is (see address.ts).
		let live: ReadonlySet<string> | undefined;
		const countLive = async () => {
			try {
				const { present } = await census(presences.all());
				live = new Set(present.map((one) => one.session));
			} catch {
				// Uncounted, the last count stands.
			}
		};
		/**
		 * Who the live peers are parked on, for the machine queue to give
		 * their heavy work its turn first (see lib/internal/priority/awaited.ts).
		 */
		const awaited = () =>
			awaitedSessions(
				board.all(),
				// This peer is there whether or not it was counted yet.
				presences
					.all()
					.filter(
						(one) =>
							one.session === peer?.session || (live?.has(one.session) ?? true),
					),
			);
		let untellAwaited: (() => void) | undefined;
		// The realms this one may send to, as the node last said; asked as
		// the session starts and again each time the node counts this
		// process present anew, as after it restarts (see lib/mesh/flow.ts).
		let flows: Promise<readonly string[]> = Promise.resolve([]);
		let unhearPresent: (() => void) | undefined;
		const askFlows = () => {
			flows = flowsAt(nodeSocket(env));
		};
		// Whose quest address this peer was told it left, and what it last
		// signed as, so each is said once.
		let leftTo: string | undefined;
		let signed: string | undefined;
		/**
		 * Tell both sides when this peer leaves its quest's address to a
		 * live peer that already signs with it: two sessions on one quest
		 * are how work gets done twice, so each is asked to say what it
		 * takes. A change of signature is said on screen.
		 */
		const identity = () => {
			if (!peer) return;
			const holder = peer.yieldedTo;
			const quest = holder?.addresses[0];
			if (holder && quest && holder.session !== leftTo) {
				const sig = peer.signature;
				const message = transport.send({
					from: sig,
					to: [homeOf(quest)],
					intent: "fyi",
					text: `${sig} has quest ${quest} loaded too. ${quest} stays this peer's address and ${sig} signs as itself; both hear the quest's group. Say which part of the quest each is taking, so neither repeats the other's work.`,
					...senderIdentity(),
				});
				seen.add(message.id);
				pi.sendMessage(
					{
						customType: NOTED,
						content: `Another live session, ${quest}, already has this quest loaded and signs with its address, so this peer signs as ${sig} until it ends; both hear the quest's group, and ${quest} has been told. Before starting on the quest, see what ${quest} is on (mesh_groups) and agree with it which part each takes, so neither repeats the other's work.`,
						display: true,
						details: { ...delivered([], []), leftTo: holder.session },
					},
					{ triggerTurn: false },
				);
			}
			leftTo = holder?.session;
			if (signed !== undefined && signed !== peer.signature && ctx?.hasUI) {
				ctx.ui.notify(`Mesh: this peer signs as ${peer.signature} now`, "info");
			}
			signed = peer.signature;
		};
		// Holds this peer waited on that are over, waiting to settle as acts
		// do, so peers held by one hold do not all carry on at once.
		let resumes: Acts<HoldEnd> | undefined;
		let waitClock: ReturnType<typeof setInterval> | undefined;
		let acts: Acts<Heeded> | undefined;
		// Messages other peers have answered, so a question to the machine
		// that one peer took up starts no turn of the rest. A question that
		// asks each peer is answered for this one only by its own reply.
		const answered = new Set<string>();
		// Questions this peer left to the peer answering them, by id, kept
		// until answered so one let go reaches this peer after all.
		const left = new Map<string, Left>();
		// Answers this peer owes and is owed, so a question put to it is
		// asked again and one it put is said to be stuck (lib/mesh/owed.ts).
		const owing = createOwing();
		const awaiting = createAwaiting();
		let ctx: ExtensionContext | undefined;
		let peer: Peer | undefined;
		// Whether this session keeps peers' news off its screen, and how many
		// messages it keeps off now (see quiet.ts).
		let quiet = false;
		let keptOff = 0;
		const showQuiet = () => {
			if (!ctx?.hasUI) return;
			ctx.ui.setStatus(
				QUIET_STATUS,
				quiet ? quietStatus(keptOff, ctx.ui.theme) : undefined,
			);
		};
		// Woken from parking, this session reads what waited once its
		// catch-up is done; either can come first, since parking says so
		// from its own start (see readWhatWaited).
		let woken = false;
		let startCaughtUp = false;
		// A turn was asked for since this start, so what waited is read.
		let turnAsked = false;
		// Messages handed over since this start without a turn.
		let handedNow = 0;
		// The model call under way, timed for the usage presence says.
		let call: { startedAt: number; firstTokenAt?: number } | undefined;
		// While a peer stands, its presence shows this session's wants, so
		// nothing else need notify the person of them (wants.ts).
		let hideWants: (() => void) | undefined;
		// What this session's quest has waiting on the person (wait.ts).
		const waiting: Waiting | undefined = paths.waiting
			? {
					folder: paths.waiting,
					quest: () =>
						peer ? loadedQuest(peer.session, paths.sessions) : undefined,
					window: () => (peer ? presences.of(peer.session)?.title : undefined),
					owner: () =>
						peer
							? {
									session: peer.session,
									address: peer.signature,
									sandbox:
										process.env[SANDBOX_VARIABLE] === STRICT
											? "strict"
											: "none",
								}
							: undefined,
					locked: <T>(quest: string, change: () => T): T => {
						const dir = join(paths.quests, quest);
						return existsSync(dir) ? withQuestLock(dir, change) : change();
					},
					heard: (items) => {
						settleWatch?.heard(items);
						watchSettled();
					},
				}
			: undefined;
		// What this session raised for the person, heard when it settles.
		const settleWatch = waiting ? watchSettling(waiting) : undefined;
		let settleClock: ReturnType<typeof setInterval> | undefined;
		const wanting = new Map<WantKind, Want>();
		const unlanded: Landing[] = [];
		// A session on no model is said at its start, perhaps before this
		// peer is made, and before every turn after: held until then, and
		// told once.
		let onNoModelUntold: NoModelEvent | undefined;
		let toldOnNoModel = false;
		const tellNoModel = (event: NoModelEvent) => {
			if (toldOnNoModel) return;
			if (!peer) {
				onNoModelUntold = event;
				return;
			}
			toldOnNoModel = true;
			onNoModelUntold = undefined;
			const message = tellOnNoModel(peer, transport, event, presences.all());
			if (message) seen.add(message.id);
		};
		let classifier: Promise<FoundClassifier> | undefined;
		let stopWatching: (() => void) | undefined;
		// Every id already looked at, so a watcher that reports one twice,
		// as inotify does for a rename, is handed over once.
		const seen = new Set<string>();
		// How far the read marker may move: only past what was handed over.
		let front = createReadFront();
		let lookClock: ReturnType<typeof setInterval> | undefined;
		// Asking GitHub about the person's looks at pull requests, a turn
		// across every session (looks-github.ts).
		let looksClock: ReturnType<typeof setInterval> | undefined;
		// A turn a note would start waits for a reload that is waiting: the
		// note is said now, without it, and the landing starts it (hold.ts).
		const holdTurn = createReloadHold();
		/**
		 * Whether the turn a note would start is put off for a waiting
		 * reload. If no reload takes it within the hold, the note's own turn
		 * starts then; a run under way by then reads the note, so the turn is
		 * taken and nothing more is started.
		 */
		const putOffTurn = (): boolean => {
			if (!holdTurn()) return false;
			oweTurnToReload();
			const due = () => {
				let idle = false;
				try {
					idle = ctx?.isIdle?.() ?? false;
				} catch {
					// A stale context: the reload landed, and its landing took the turn.
					return;
				}
				if (!takeOwedTurn() || !idle) return;
				try {
					pi.sendMessage(
						{
							customType: NOTED,
							content: TURN_PUT_OFF,
							display: false,
						},
						{ triggerTurn: true },
					);
				} catch {
					// A stale pi: a reload replaced it, and its landing starts the turn.
				}
			};
			setTimeout(due, HOLD_FOR_RELOAD_MS).unref?.();
			return true;
		};
		let steering: Steering | undefined;
		/** Where the steer inboxes are, once the mesh says. */
		let steerRoot: string | undefined;
		/** The last restart in place asked of this session, if any. */
		let restartAsked: RestartAsk | undefined;
		// What became of each steer that asked to be followed (talks.ts).
		const talks = createTalks({
			session: () => peer?.session ?? "",
			inboxes: () =>
				steerRoot === undefined
					? []
					: (peer?.addresses ?? []).map((address) =>
							inboxOf(steerRoot ?? "", address),
						),
		});
		// Pause, Resume, Stop, Close and Carry from outside the window (pausing.ts).
		const pausing = createPausing({
			idle: () => ctx?.isIdle?.() ?? true,
			abort: () => {
				// Stopped from outside, not by the person: away mode stays on.
				// The inbox watch runs outside any hosted dispatch, so the mark
				// names this session; with no session there is no run to stop.
				if (!ctx) return;
				stoppingFromOutside(ctx);
				ctx.abort?.();
			},
			paused: () => peer?.paused ?? false,
			setPaused: (paused) => peer?.setPaused(paused),
			carryOn: () => pi.sendUserMessage(RESUMED_TEXT),
			tell: (text) => {
				if (ctx?.hasUI) ctx.ui.notify(text, "info");
			},
			// Plain pi waits until it is idle, so the run just ended winds down
			// first; a host closes it as a Close over its socket does.
			close: (by) => {
				if (ctx) endConversation(ctx, by);
			},
			carry: async (to) => {
				if (!ctx) throw new Error("the session isn't there to carry.");
				await carryThisSession(ctx, to);
			},
		});
		// Prompts open for the person, which a move waits out.
		let prompts = 0;
		// When a key was last pressed in this window, which a move in place
		// waits to go quiet.
		let keyedAt = Number.NEGATIVE_INFINITY;
		let unhearKeys: (() => void) | undefined;
		// The host this conversation runs in, by key, read where hosted() knows.
		let hostKey: string | undefined;
		// A host's conversation has no window of its own to hand over.
		const handOver = () =>
			ctx?.hasUI && peer && hostKey === undefined
				? handOverOf({
						env,
						pid: senderIdentity().pid,
						args: process.argv.slice(2),
						session: peer.session,
						sessionFile: ctx.sessionManager.getSessionFile(),
					})
				: undefined;
		// Move into a host or out of one, from outside the window (moving.ts).
		const moving = createMoving({
			holds: () => holdsOf(ctx, pi.events, prompts),
			hosted: () => hostKey !== undefined,
			moving: () => peer?.moving,
			setMoving: (one) => peer?.setMoving(one),
			note: (to) => {
				if (!ctx || !peer) throw new Error("the session isn't there to move.");
				const said = presences.of(peer.session);
				const quest = said?.quest;
				const pid = said?.owner?.pid;
				if (pid === undefined)
					throw new Error("its presence names no owner to watch end.");
				const title = ctx.sessionManager.getSessionName();
				// The fence and spawner go with it, as a holder's restart takes them.
				const carried = carriedEnvironment(env);
				writeMoveNote(
					moveNoteOf(
						ctx,
						{
							session: peer.session,
							cwd: sessionCwd(ctx),
							addresses: peer.addresses,
							...(quest ? { quest } : {}),
							...(title ? { title } : {}),
							...(hostKey ? { from: hostKey } : {}),
							pid,
							...(carried ? { env: carried } : {}),
						},
						to,
					),
				);
			},
			handOver,
			keyedAt: () => keyedAt,
			tell: (text) => {
				if (ctx?.hasUI) ctx.ui.notify(text, "info");
			},
			close: (by) => {
				if (ctx) endConversation(ctx, by);
			},
			// Through its host, so a window viewing it carries on as plain pi.
			release: async (by) => {
				const owner = peer ? presences.of(peer.session)?.owner : undefined;
				return (
					owner !== undefined &&
					(await releaseThroughHost(owner, by)) === "ended"
				);
			},
		});

		/**
		 * The person's words from outside the window, as their own message:
		 * a turn when idle, or into the run under way, read after its tool.
		 */
		const steered = (text: string, idle: boolean) => {
			pi.sendUserMessage(text, idle ? undefined : { deliverAs: "steer" });
		};

		/**
		 * An answer the person gave from the launcher: an open ask takes it
		 * as typed, a look resolves and its answer goes to the agent, or,
		 * when either has moved on, the window says so.
		 */
		const answerFromAway = (one: Steer) => {
			const at = ctx;
			if (!at) return;
			const tell = (text: string) => {
				if (at.hasUI) at.ui.notify(text, "info");
			};
			if (one.look === undefined) {
				answerSteered(one, sessionKeyOf(at), tell);
				return;
			}
			if (!(paths.looks && peer)) {
				tell(LOOK_GONE);
				return;
			}
			const quest = loadedQuest(peer.session, paths.sessions);
			answerLookSteered(
				one,
				paths.looks,
				{ session: peer.session, ...(quest ? { quest } : {}) },
				(text) => steered(text, at.isIdle?.() ?? true),
				tell,
			);
		};

		/** Steering for this session's addresses, when the mesh has inboxes. */
		const steer = (root: string | undefined) => {
			steering?.stop();
			steering = undefined;
			steerRoot = root;
			if (root === undefined) return;
			steering = createSteering({
				root,
				addresses: () => peer?.addresses ?? [],
				deliver: (one, inbox) => {
					if (one.act === "carry") {
						if (one.to !== undefined) void pausing.carry(one.to, one.from);
						return;
					}
					if (one.act === "fill") {
						fillPrompt(ctx, one.text);
						return;
					}
					if (one.act === "move") {
						if (isMoveTarget(one.to)) moving.move(one.to);
						return;
					}
					if (one.act === "answer") {
						answerFromAway(one);
						return;
					}
					// A resume, a talk or typing says the person is at the desk.
					if (one.act === "resume" || !one.act) moving.cancel();
					// Resume with words is a talk; any other act is only the act.
					if (one.act && !(one.act === "resume" && one.text)) {
						pausing.act(one.act, one.from);
						return;
					}
					pausing.talked();
					const idle = ctx?.isIdle?.() ?? true;
					const said = steerText(one, { busy: !idle });
					talks.opened(one, inbox, said);
					steered(said, idle);
				},
				setAside: (inbox, names) => {
					if (!ctx?.hasUI) return;
					ctx.ui.notify(
						`Talk: set aside ${names.join(", ")} in ${inbox}, which held no text to deliver.`,
						"warning",
					);
				},
			});
			setTimeout(() => steering?.look(), FIRST_STEER_MS).unref?.();
		};

		/** These were handed over, or need nothing more: the marker follows. */
		const handedOver = (messages: readonly Message[]) => {
			const to = front.handed(messages.map((one) => one.id));
			if (to !== undefined && peer) transport.markRead(peer.signature, to);
		};

		/** Whose business a message is, by the classifier, or nothing. */
		const judge = async (
			message: Message,
			receiver: Receiver,
		): Promise<Concern | undefined> => {
			// What is sent to this peer is noted whatever it says, so asking
			// about it would spend a call on an answer nothing reads.
			if (isHomeTo(message, receiver.addresses)) return undefined;
			// What the words already show needs no classifier: naming this peer
			// or what it owns is about its work.
			if (mentions(message, receiver)) return "receiver";
			try {
				const found = await classifier;
				if (!found?.ok) return undefined;
				const result = await found.classify(
					{
						state: concernState(message, receiver),
						questions: concernQuestionFor(receiver),
					},
					AbortSignal.timeout(JUDGE_MS),
				);
				return result.stopReason === "stop"
					? concernFrom(result.answers.about)
					: undefined;
			} catch {
				// An unjudged message is noted, which is never wrong for long.
				return undefined;
			}
		};

		/**
		 * The classifier's pick of a group for a message its sender named
		 * none for, or nothing, in which case it is routed by rule.
		 */
		const routing: Judge = async (context) => {
			const found = await classifier;
			if (!found?.ok) return undefined;
			const result = await found.classify(
				context,
				AbortSignal.timeout(JUDGE_MS),
			);
			return result.stopReason === "stop" ? result.answers.to : undefined;
		};

		/**
		 * The attention each message gets here, judged together. Starting,
		 * it is a catch-up: nothing takes a turn, and a long one is held to what
		 * a peer starting can take in.
		 */
		const route = async (messages: readonly Message[], starting = false) => {
			if (messages.length === 0 || !ctx || !peer) return;
			// The peer this was routed for: a session that ends while it is
			// judged leaves the rest undone (see session_shutdown).
			const routedFor = peer;
			peer.refresh();
			identity();
			// What it changes now tells its business from another's best.
			const receiver: Receiver = {
				...peer.receiver,
				changing: changesOf(board.of(peer.session)?.leases ?? []),
			};
			const self: Self = { addresses: peer.addresses, ...senderIdentity() };
			const listener = peer.listener;
			// Every address the orchestrator signs with, so a pivot under
			// either its quest's or its session's is known as its own.
			const orchestrator = peer.orchestratedBy
				? addressesOf(peer.orchestratedBy)
				: undefined;
			const read = (id: string) => transport.read(id);
			const everyone = presences.all();
			const stopped = messages.map((message) =>
				isStopped(message, peer?.stops ?? [], everyone),
			);
			const answering = messages.map((message) => answers(message, read, self));
			// What an orchestrator can read from a sender's presence rather than
			// its message: only an orchestrator is spared, since only it is sent
			// status (RSCH-20261031-GUDOJV, piece 1).
			const restating = messages.map(
				(message) =>
					peer?.orchestrates !== undefined &&
					message.intent === "fyi" &&
					namesLanding(
						message.text,
						everyone.find((one) => one.addresses.includes(message.from))
							?.landings ?? [],
					),
			);
			const led = messages.map(
				(message) =>
					routedFor.orchestrates !== undefined &&
					ledBy(
						everyone.find((one) => one.addresses.includes(message.from)),
						routedFor.addresses,
					),
			);
			const asked = messages.map((message) =>
				answersQuestion(message, read, self),
			);
			const concerns = await Promise.all(
				messages.map((message, at) =>
					// A peer hearing only what is put to it glances at the rest
					// whatever the classifier says, so it isn't asked.
					stopped[at] ||
					answeringAt(answering, at) ||
					receiver.hears === "addressed"
						? undefined
						: judge(message, receiver),
				),
			);
			if (peer !== routedFor) return;
			// Never while starting: the first prompt is about to run, and pi
			// refuses a second turn asked for beside it.
			const idle = !starting && (ctx.isIdle?.() ?? false);
			const raisedAll: Heed[] = messages.map((message, at) => {
				// Stopped is absolute: a line, never more, whatever it is.
				if (stopped[at]) return { attention: "glance", why: STOPPED };
				const judged = attend(message, {
					receiver,
					idle,
					answers: answeringAt(answering, at),
					asked: answeringAt(asked, at),
					askedEach: asksEach(message, listener),
					now: Date.now(),
					...(restating[at] ? { restates: true } : {}),
					...(led[at] ? { led: true } : {}),
					...(orchestrator ? { orchestrator } : {}),
					...(concerns[at] ? { concern: concerns[at] } : {}),
				});
				// What a starting peer catches up on rides the first prompt. A
				// peer started with none, as a parked one is woken by a message,
				// has no turn coming but this one: on 6 November a question
				// that woke one was only noted, owed nothing, and the peer
				// parked again with it unanswered.
				const worth: Heed =
					starting && judged.attention === "turn" && firstPromptPending()
						? { attention: "note", why: judged.why }
						: judged;
				const replaced = replacedBy(message);
				// A withdrawal reaches in full everyone who heard what it
				// withdraws, and what it withdraws is never handed over after it.
				// A peer hearing only what is put to it glanced at the original,
				// so a glance takes its place.
				const heard =
					replaced !== undefined &&
					receiver.hears !== "addressed" &&
					reaches(replaced, listener, senderIdentity().pid);
				if (replaced) {
					glances.drop(replaced.id);
					acts?.drop((one) => one.message.id === replaced.id);
					handedOver([replaced]);
				}
				return heard && worth.attention === "glance"
					? { attention: "note", why: "replacing what this peer heard" }
					: worth;
			});
			const homes = peer.addresses.map(homeOf);
			const raisedEach =
				starting && messages.length > MOST_CAUGHT_UP
					? caughtUp(
							messages.map((message, at) => ({
								message,
								heed: raisedAll[at] as Heed,
								own:
									message.intent === "hold" ||
									answeringAt(answering, at) ||
									answeringAt(asked, at) ||
									message.to.some((group) => homes.includes(group)),
							})),
						)
					: raisedAll;
			const damped: string[] = [];
			const inFull: Message[] = [];
			const heeded: Heeded[] = messages.map((message, at) => {
				const raised = raisedEach[at] as Heed;
				const heed = damper.damp(
					message,
					raised,
					depthOf(message, read),
					Date.now(),
					inFull,
				);
				if (heed.attention !== raised.attention) damped.push(heed.why);
				if (heed.attention !== "glance") inFull.push(message);
				return { message, heed };
			});
			say(damped);
			for (const { message, heed } of heeded) {
				if (heed.attention === "glance") glance(message, heed.why);
				if (heed.attention === "act") acts?.add({ message, heed });
			}
			const now = heeded.filter(
				({ heed }) => heed.attention === "note" || heed.attention === "turn",
			);
			note(
				now,
				now.some(({ heed }) => heed.attention === "turn"),
			);
		};

		/** The earlier message this one validly replaces, if any. */
		const replacedBy = (message: Message): Message | undefined => {
			if (message.supersedes === undefined) return undefined;
			const original = transport.read(message.supersedes);
			return original && mayReplace(message, original) ? original : undefined;
		};

		/** Damping said on screen, where the person sees it and the model not. */
		const say = (damped: readonly string[]) => {
			if (damped.length === 0 || !ctx?.hasUI) return;
			ctx.ui.notify(
				`Mesh: held back (${[...new Set(damped)].join("; ")})`,
				"info",
			);
		};

		/** A line on screen now, and for the model with its next turn. */
		const glance = (message: Message, why: string) => {
			pi.appendEntry(GLANCE, { message, why });
			glances.add(message);
			// Recorded in the session, so a reload finds it waiting still.
			handedOver([message]);
		};

		/**
		 * What waited to act, less what came from a peer stopped since: a
		 * stop reaches what is already waiting, which becomes a glance.
		 */
		const unstopped = (waiting: readonly Heeded[]): Heeded[] => {
			const everyone = presences.all();
			return waiting.filter(({ message }) => {
				if (!isStopped(message, peer?.stops ?? [], everyone)) return true;
				glance(message, STOPPED);
				return false;
			});
		};

		/**
		 * Messages in full, carrying whatever glances are waiting. A turn
		 * takes whatever waits to act with it, since it is the turn they
		 * were waiting for. A session its person paused gets them without
		 * a turn, to read once resumed.
		 */
		const note = (heeded: readonly Heeded[], asked: boolean, lead?: string) => {
			const turn = asked && !pausing.paused;
			const all = turn ? [...heeded, ...unstopped(acts?.take() ?? [])] : heeded;
			if (all.length === 0) return;
			const messages = all.map(({ message }) => message);
			if (turn) leasing.answering(messages);
			for (const { message, heed } of all) {
				if (
					turn &&
					heed.addressed &&
					message.intent === "question" &&
					// No answer reaches back to another realm, so none is owed.
					message.fromRealm === undefined
				) {
					owing.owe(message);
				}
			}
			const carried = glances.take();
			const content = noted(messages, carried, peer?.orchestratedBy);
			// What asked for a turn, or answers this peer, shows on a quiet
			// screen though a pause held its turn back.
			const forThisPeer =
				asked || all.some(({ heed }) => heed.awaited || heed.addressed);
			// pi's own first prompt, still to come, is the turn that reads it.
			const putOff = turn && (firstPromptPending() || putOffTurn());
			if (turn) turnAsked = true;
			else handedNow += messages.length;
			pi.sendMessage(
				{
					customType: NOTED,
					content: lead ? `${lead}\n\n${content}` : content,
					display: true,
					details: delivered(messages, carried, {
						turn,
						why: all.map(({ heed }) => heed.why),
						...(forThisPeer ? { forThisPeer } : {}),
					}),
				},
				{ triggerTurn: turn && !putOff },
			);
			if (quiet && folds({ messages, turn, forThisPeer })) {
				keptOff += messages.length;
				showQuiet();
			}
			handedOver(messages);
			damper.handed(messages);
		};

		/**
		 * What waited to act, once the mesh has settled: a turn for what is
		 * still worth one and affordable, and a note for the rest, such as a
		 * group's question another peer has answered meanwhile.
		 */
		const settled = async (arrived: Heeded[]) => {
			if (!ctx || !peer) return;
			const waiting = unstopped(arrived);
			// A question another peer has a turn for is left to it, unless it
			// asks each peer, when another's answer is not this one's.
			const listener = peer.listener;
			const each = waiting.map(({ message }) => asksEach(message, listener));
			const answerers = await Promise.all(
				waiting.map(({ message }, at) =>
					message.intent === "question" && !each[at]
						? leasing.answeredBy(message).catch(() => undefined)
						: undefined,
				),
			);
			if (!ctx || !peer) return;
			const read = (id: string) => transport.read(id);
			const idle = ctx.isIdle?.() ?? false;
			const damped: string[] = [];
			const now = waiting.map(({ message, heed }, at): Heeded => {
				if (
					answered.has(message.id) &&
					message.intent === "question" &&
					!each[at]
				) {
					return {
						message,
						heed: { attention: "note", why: `${heed.why}, answered already` },
					};
				}
				const answerer = answerers[at];
				if (answerer !== undefined) {
					left.set(message.id, { message, heed, by: answerer });
					return {
						message,
						heed: {
							attention: "note",
							why: `${heed.why}, being answered by ${answerer}`,
						},
					};
				}
				// A busy peer reads a note once the model's current call ends,
				// which may be the run's last, leaving it for the person to
				// speak. What this peer waits on or is asked is steered in.
				if (!idle && !heed.awaited && !heed.addressed)
					return { message, heed: { attention: "note", why: heed.why } };
				const held = damper.damp(message, heed, depthOf(message, read));
				if (held.attention !== heed.attention) damped.push(held.why);
				return { message, heed: held };
			});
			say(damped);
			const glanced = now.filter(({ heed }) => heed.attention === "glance");
			for (const { message, heed } of glanced) glance(message, heed.why);
			const full = now.filter(({ heed }) => heed.attention !== "glance");
			const turn = full.some(({ heed }) => heed.attention === "act");
			note(
				full.map(({ message, heed }) => ({
					message,
					heed: turn ? heed : { ...heed, attention: "note" },
				})),
				turn,
			);
		};

		/** The glances waiting, as a digest of their own, or nothing. */
		const glanceDigest = () => {
			const carried = glances.take();
			if (carried.length === 0) return undefined;
			return {
				customType: GLANCES,
				content: digest(carried),
				// Each was shown on screen as it arrived; showing them again
				// would only say the same thing twice.
				display: false,
				details: delivered([], carried),
			};
		};

		const take = (id: string): Message | undefined => {
			if (seen.has(id) || !peer) return undefined;
			seen.add(id);
			const message = transport.read(id);
			// A file caught half written reads as nothing: the next look takes
			// it again rather than counting it seen and losing it for good.
			if (!message) seen.delete(id);
			// A hold this peer waits on can end in a message to a group it does
			// not hear, so ends are looked for before what reaches it.
			const end = message ? leasing.ended(message) : undefined;
			if (end) resumes?.add(end);
			// Answers are counted wherever they went, so a question to a group
			// one peer took up is known as answered by every other.
			if (
				message?.re !== undefined &&
				!sentBy(message, { addresses: peer.addresses, ...senderIdentity() })
			) {
				answered.add(message.re);
				awaiting.answered(message.re, () => addressesOf(message.from));
			}
			if (!message || !reaches(message, peer.listener, senderIdentity().pid)) {
				return undefined;
			}
			// The marker passes it only once it is handed over (see reading.ts).
			front.taken(id);
			// Brought into a group by another peer: it joins without being
			// asked, as Joel wants agents to organise themselves, and the note
			// it gets says how to leave.
			if (
				message.invite !== undefined &&
				!isStopped(message, peer.stops, presences.all()) &&
				isHomeTo(message, peer.addresses) &&
				groupNamed(message.invite) === message.invite &&
				message.invite.startsWith("#") &&
				isJoinable(message.invite)
			) {
				peer.join(message.invite);
			}
			return message;
		};

		/**
		 * Questions left to a peer that took them up, waiting to act here
		 * after all once it lets one go unanswered: its run ended, or it did,
		 * with no answer sent. Every other peer had stood aside, so a question
		 * one took up and dropped was otherwise answered by nobody.
		 */
		const reconsider = async () => {
			const now = Date.now();
			for (const [id, one] of [...left]) {
				if (answered.has(id) || now - Date.parse(one.message.at) > LEFT_MS) {
					left.delete(id);
					continue;
				}
				const still = await leasing.answeredBy(one.message).catch(() => one.by);
				if (still !== undefined || !left.delete(id) || !acts) continue;
				acts.add({
					message: one.message,
					heed: {
						...one.heed,
						why: `${one.heed.why}, let go unanswered by ${one.by}`,
					},
				});
			}
		};

		/** The addresses of the peer signing as this, as far as presence says. */
		const addressesOf = (from: string): readonly string[] =>
			presences.all().find((one) => one.addresses.includes(from))
				?.addresses ?? [from];

		/**
		 * Questions put to this peer that it hasn't answered, handed again
		 * with a turn; and questions it put that are stuck, said on screen
		 * and to its model, once each.
		 */
		const chase = () => {
			// A busy session reads what it was handed when pi gets to it, one
			// at a time; asking again meanwhile only queues reminders that
			// arrive after the answer they ask for. Its run ending unanswered
			// is what the asking again is for.
			const again = (ctx?.isIdle?.() ?? true) ? owing.due() : [];
			if (again.length > 0) {
				const minutes = Math.round(ASK_AGAIN_MS / 60_000);
				note(
					again.map(({ message }) => ({
						message,
						heed: {
							attention: "turn",
							why: "asked again, unanswered",
							addressed: true,
						},
					})),
					true,
					`Asked again: ${again.length === 1 ? "this question was" : "these questions were"} put to you at least ${minutes} minutes ago and you have sent no answer. Answer now with mesh_send, re set to its id, or say when you will.`,
				);
			}
			const stuck = awaiting.stuck();
			if (stuck.length === 0) return;
			const lines = stuck.map(
				({ message, waitingOn }) =>
					`Your question [${shortId(message)}] from ${clock(message)} has had no answer from ${waitingOn.join(", ")}. It has been put to them again; mesh_groups says what each is doing.`,
			);
			if (ctx?.hasUI) {
				ctx.ui.notify(
					`Mesh: no answer yet from ${[...new Set(stuck.flatMap((one) => one.waitingOn))].join(", ")}`,
					"warning",
				);
			}
			pi.sendMessage(
				{
					customType: NOTED,
					content: lines.join("\n\n"),
					display: true,
					details: delivered([], []),
				},
				{ triggerTurn: false },
			);
		};

		/** Messages the watcher never reported, taken as it would have. */
		const lookAgain = () => {
			if (!peer) return;
			chase();
			// Who is still there changes without a message saying so: a
			// quest's address left to a peer that ended is taken back.
			void countLive().then(() => {
				peer?.refresh();
				identity();
				steering?.look();
				// A parked peer told to close or carry is started again to do it.
				if (paths.steer !== undefined) {
					wakeSteered(presences.all(), paths.steer, isParked, askWake);
				}
			});
			if (left.size > 0) void reconsider();
			// Listed a little at a time: the folder holds a week of messages,
			// and listing it at once held the thread a key waits on.
			void transport.listIds().then((ids) => {
				const missed = ids
					.filter((id) => !seen.has(id))
					.map(take)
					.filter((one): one is Message => one !== undefined);
				if (missed.length > 0) void route(missed);
			});
		};

		// A glance is the model's: on screen it is nothing (see render.ts).
		pi.registerEntryRenderer?.(GLANCE, () => NOTHING_SHOWN);
		// While quiet, a delivery that only tells draws nothing (see quiet.ts).
		pi.registerMessageRenderer?.<Shown & Folding>(
			NOTED,
			// Expanded (ctrl+o, as for tool output), quiet keeps nothing off.
			(message, options, theme) =>
				quiet && !options.expanded && folds(message.details)
					? NOTHING_SHOWN
					: expandable(message, options.expanded, (width, expanded) =>
							meshLines(
								textOf(message.content),
								message.details,
								theme,
								width,
								expanded,
							),
						),
		);
		// Into a host from inside the window, in place (host-command.ts).
		pi.registerCommand?.("host", {
			description:
				"/host [attended|background]: move this session into that host, the background one unless said, keeping this window; it waits for the session to settle first.",
			handler: async (args, at) => {
				const refusal = await moveIntoHost(args, {
					session: () => peer?.session,
					hostedIn: () => hostKey,
					moving: () => peer?.moving,
					sessionFile: () => at.sessionManager.getSessionFile(),
					handOver,
					env,
					pid: senderIdentity().pid,
					args: process.argv.slice(2),
					machine: hostname().split(".")[0] ?? "",
					agents: () => agentsAt(nodeSocket(env)),
					probe: probeHost,
					move: (to) => moving.move(to, "here"),
					takeUp: (session, to) => startTakeUp(session, to, paths.mesh, env),
				});
				if (refusal !== undefined) at.ui.notify(refusal, "warning");
			},
		});
		pi.registerCommand?.("mesh", {
			description:
				"/mesh quiet [on|off]: keep other sessions' fyis and findings off this screen; questions, holds and pivots still show, and the model reads them all.",
			handler: async (args, at) => {
				const wanted = quietWanted(args, quiet);
				if (wanted === undefined) {
					at.ui.notify("Usage: /mesh quiet [on|off]", "warning");
					return;
				}
				quiet = wanted;
				pi.appendEntry(QUIET, { on: quiet });
				showQuiet();
				at.ui.notify(quietSaid(quiet), "info");
			},
		});

		/**
		 * Holds this peer waited on that are over: a turn to carry on while
		 * idle, and a note mid-run. It is this peer's own work resuming, not
		 * another's interruption, so damping leaves it be.
		 */
		const resumed = (ends: HoldEnd[]) => {
			if (!ctx || ends.length === 0) return;
			const turn = (ctx.isIdle?.() ?? false) && !pausing.paused;
			const carried = glances.take();
			const putOff = turn && (firstPromptPending() || putOffTurn());
			pi.sendMessage(
				{
					customType: NOTED,
					content: holdsOver(ends, carried),
					display: true,
					details: delivered([], carried, {
						turn,
						why: ends.map(({ how }) => `a hold this peer waited on, ${how}`),
					}),
				},
				{ triggerTurn: turn && !putOff },
			);
		};

		/**
		 * Once a session woken from parking has caught up, a turn over what
		 * was handed over since its last turn, unless one is asked already.
		 * Without it a key that woke a session left it to the person to type
		 * something before it read anything (7 November, three orchestrators).
		 */
		const readWhatWaited = () => {
			if (!woken || !startCaughtUp || !ctx) return;
			woken = false;
			// A first prompt to come, a run under way, or an act's turn held
			// for the mesh to settle, reads them itself.
			if (
				turnAsked ||
				pausing.paused ||
				firstPromptPending() ||
				(acts?.pending() ?? false)
			) {
				return;
			}
			let waiting = 0;
			try {
				if (!(ctx.isIdle?.() ?? false)) return;
				waiting =
					handedNow +
					handedSinceLastTurn(ctx.sessionManager.getBranch?.() ?? []);
			} catch {
				// A stale context: a reload replaced it, and its start reads afresh.
				return;
			}
			if (waiting === 0) return;
			turnAsked = true;
			pi.sendMessage(
				{ customType: NOTED, content: WOKEN_TO_READ, display: true },
				{ triggerTurn: true },
			);
		};

		/** Whether the holds waited on still stand, asked while any is. */
		const checkWaits = async () => {
			const ends = await leasing.lapsed().catch(() => []);
			for (const end of ends) resumes?.add(end);
			if (!own?.leases.some((lease) => lease.kind === "wait")) {
				clearInterval(waitClock);
				waitClock = undefined;
			}
		};
		/**
		 * Tell this session what it raised for the person has settled: a
		 * turn of its own when idle, since a run that ended Blocked on him
		 * has nothing else to wake it, and after the run under way if not.
		 */
		const tellSettled = () => {
			if (!settleWatch || !ctx) return;
			let gone: ReturnType<typeof settleWatch.settled>;
			let idle: boolean;
			try {
				gone = settleWatch.settled();
				idle = ctx.isIdle?.() ?? false;
			} catch {
				// A file being replaced or a stale context: the next tick looks again.
				return;
			}
			if (!settleWatch.watching()) {
				clearInterval(settleClock);
				settleClock = undefined;
			}
			if (gone.length === 0) return;
			const message = {
				customType: NOTED,
				content: settledText(gone),
				display: true,
			};
			if (!idle) {
				pi.sendMessage(message, { deliverAs: "followUp" });
				return;
			}
			const turn = !turnAsked && !pausing.paused;
			if (turn) turnAsked = true;
			pi.sendMessage(message, { triggerTurn: turn });
		};
		const watchSettled = () => {
			if (settleClock || !settleWatch?.watching()) return;
			settleClock = setInterval(tellSettled, waitCheckMs);
			settleClock.unref?.();
		};

		const watchWaits = () => {
			if (waitClock || !own?.leases.some((lease) => lease.kind === "wait")) {
				return;
			}
			waitClock = setInterval(() => void checkWaits(), waitCheckMs);
			waitClock.unref?.();
		};

		pi.on("session_start", async (_event, started) => {
			if (isEphemeral(started.sessionManager) || env[MESH_ENV] === "off") {
				return;
			}
			// A session this process rolled away from, started again, is no
			// peer: on 3 November one caught up on 13 messages the live
			// session it had become never got (lib/internal/session/left.ts).
			if (sessionLeft(started.sessionManager.getSessionId())) return;
			// A plain pi on a log a host holds ends at once, and its peer is
			// the host's: on 10 November one wrote its pid over it.
			if (
				!hosted() &&
				(await writerHold(started.sessionManager.getSessionId()))
			)
				return;
			ctx = started;
			unhearKeys?.();
			unhearKeys = started.hasUI
				? started.ui.onTerminalInput(() => {
						keyedAt = Date.now();
						return undefined;
					})
				: undefined;
			startCaughtUp = false;
			turnAsked = false;
			handedNow = 0;
			// The node hears this process end the moment it does, crash or
			// not; a reload keeps the one connection it already holds.
			keepPresent(nodeAt(env));
			askFlows();
			unhearPresent?.();
			unhearPresent = whenPresent(askFlows);
			// Named on its presence so others can ask the machine whether this
			// peer is still there; a peer the machine will not name is taken
			// as there, which only costs a sender a line.
			const owner = await sessionOwner(started).catch(() => undefined);
			const branch = (started.sessionManager.getBranch?.() ??
				[]) as readonly Entry[];
			const session = sessionKeyOf(started);
			// A log rolled over into a fresh one carries on as the same peer.
			const previous = previousSession(carriedBy(branch, CARRY_NAME));
			if (previous) carryLeases(board, previous, session);
			await countLive();
			untellAwaited?.();
			untellAwaited = tellAwaited(awaited);
			// Said already before a reload is not said again.
			leftTo = leftToIn(branch);
			quiet = quietIn(branch);
			keptOff = keptOffIn(branch);
			showQuiet();
			signed = undefined;
			const host = hosted();
			hostKey = host?.key;
			peer = localPeer({
				live: () => live,
				session,
				cwd: sessionCwd(started),
				records: paths,
				presences,
				// Read at each publish, so the desktop matches this peer's
				// window by its exact title after a quest renames the session.
				title: () =>
					windowTitle(
						started.sessionManager.getSessionName(),
						started.sessionManager.getCwd(),
					),
				...(owner ? { owner } : {}),
				...(host
					? {
							hosted: hostedPresence(
								host.key,
								session,
								started.sessionManager.getSessionFile(),
								env,
							),
						}
					: {}),
				...(previous ? { previous } : {}),
				...terminalOf(),
				// Kept a month past the presence, for the desktop's Landed.
				history: landingKeeper(paths.mesh),
			});
			for (const want of wanting.values()) peer.want(want);
			// A move asked before a reload goes on waiting for the session.
			if (peer.moving) moving.look();
			// Read from the log pi holds, so the cutover need read no log.
			if (branch.some(isPersonWords)) peer.setDriven();
			// Today's usage, carried in its last presence or counted from its log.
			if (!peer.usage) {
				peer.setUsage(usageFromLog(branch, new Date()));
			}
			hideWants?.();
			hideWants = showWants();
			for (const landing of unlanded.splice(0)) peer.landed(landing);
			if (onNoModelUntold) tellNoModel(onNoModelUntold);
			if (waiting) {
				settleFromVerdicts(waiting);
				markOwnerRunning(waiting, true);
				// The first look learns what waits; what settles after is told.
				try {
					settleWatch?.settled();
				} catch {
					// A file being replaced: the next change this session makes looks again.
				}
				watchSettled();
			}
			// Named to whatever this process starts, so a subagent knows whose
			// hands it is.
			if (hosted()) sessionEnv(started).set(MESH_SESSION_ENV, peer.session);
			else env[MESH_SESSION_ENV] = peer.session;
			glances.recover(branch);
			damper.recover(saidIn(branch));
			acts?.stop();
			acts = createActs(peer.session, settling, (waiting) => {
				void settled(waiting);
			});
			resumes?.stop();
			resumes = createActs(peer.session, settling, resumed);
			// Its holds and waits outlive a reload; what a run claimed does not.
			own = ownLeases(board, peer.session);
			// Restored after a reboot, nothing it claimed is under way.
			leasing.forgetEarlierBoots();
			for (const event of unowned.splice(0)) claim(event);
			clearInterval(waitClock);
			waitClock = undefined;
			watchWaits();
			// Looked for once a session, not once a message, and not waited
			// on: a message judged before it is found waits for it, briefly.
			classifier = findClassifier(
				started,
				env[MESH_CLASSIFIER_ENV],
				MESH_CLASSIFIER_ENV,
			).catch(
				(error): FoundClassifier => ({
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				}),
			);
			// A peer reads afresh: what another session took is not this one's,
			// and what this one handed over before a reload its entries say.
			seen.clear();
			left.clear();
			for (const id of handedIn(branch)) seen.add(id);
			front = createReadFront();
			// Watching before looking, so what lands between the two is heard
			// by one of them, and seen keeps it to once.
			stopWatching?.();
			stopWatching = undefined;
			try {
				stopWatching = transport.watch((id) => {
					const message = take(id);
					if (message) void route([message]);
				});
			} catch (error) {
				// A transport that cannot be watched leaves this peer slow to
				// hear, which nothing else would show.
				if (started.hasUI) {
					started.ui.notify(
						`Mesh: cannot watch for messages (${error instanceof Error ? error.message : String(error)}), so this session looks for them once a minute instead.`,
						"warning",
					);
				}
			}
			clearInterval(lookClock);
			lookClock = setInterval(lookAgain, lookAgainMs);
			lookClock.unref?.();
			clearInterval(looksClock);
			const looksDir = paths.looks;
			if (looksDir) {
				const asking = peer.session;
				const questsDir = paths.quests;
				looksClock = setInterval(() => {
					// A quest ended in another session, or before this one began.
					endLooksOfQuests(looksDir, (quest) => questEnded(questsDir, quest));
					void askAboutLooks(pi, looksDir, asking);
					// Asks a session of this quest left as it ended come here, so
					// Needs You sends the person to one that runs.
					if (waiting) markOwnerRunning(waiting, true);
				}, LOOKS_CHECK_MS);
				looksClock.unref?.();
			}
			const since =
				transport.lastRead(peer.addresses) ??
				`${Date.now() - FIRST_CATCH_UP_MS}`;
			const missed: Message[] = [];
			for (const id of transport.ids()) {
				if (id <= since) {
					seen.add(id);
					continue;
				}
				const message = take(id);
				if (message) missed.push(message);
			}
			void route(missed, true).finally(() => {
				startCaughtUp = true;
				readWhatWaited();
			});
			steer(paths.steer);
			identity();
			void tidy();
			if (started.hasUI) {
				const groups =
					peer.groups.length > 0 ? `, in ${peer.groups.join(", ")}` : "";
				started.ui.notify(
					`Mesh: this peer is ${peer.addresses.join(" or ")}${groups}`,
					"info",
				);
			}
		});

		// A glance reaches the model with its next turn: at the end of this
		// step while a run goes on, where pi appends it after the step's
		// tool results, or with the start of the next run while idle. A
		// pause asked for mid-run lands here too, the turn's tools done.
		pi.on("turn_end", async () => {
			leasing.stillAnswering();
			const message = glanceDigest();
			if (message) pi.sendMessage(message, { triggerTurn: false });
			pausing.turnEnded();
		});
		// A run started by something else takes what was waiting to act
		// with it, in full, and the turn it waited for is never started.
		pi.on("before_agent_start", async () => {
			const waiting = unstopped(acts?.take() ?? []);
			if (waiting.length === 0) {
				const message = glanceDigest();
				return message ? { message } : undefined;
			}
			const messages = waiting.map(({ message }) => message);
			leasing.answering(messages);
			const carried = glances.take();
			handedOver(messages);
			damper.handed(messages);
			return {
				message: {
					customType: NOTED,
					content: noted(messages, carried, peer?.orchestratedBy),
					display: true,
					details: delivered(messages, carried, {
						why: waiting.map(({ heed }) => heed.why),
					}),
				},
			};
		});

		// A log about to roll over names the session the fresh one carries
		// on from, so it can take this peer's presence and leases.
		pi.events?.on(ROLLOVER_CARRY, (data: unknown) => {
			const carry = data as { carried?: unknown } | undefined;
			if (!peer || typeof carry?.carried !== "object" || !carry.carried) {
				return;
			}
			(carry.carried as Record<string, unknown>)[CARRY_NAME] = {
				session: peer.session,
			};
		});

		// The person typing in the window is at the desk: a pause ends, and
		// what they typed is the run, never ended as it starts.
		pi.on("input", async (event) => {
			// As the log is read at start: a launcher talk or an RPC client's
			// prompt is a person's too.
			if (isPersonText(event.text)) peer?.setDriven();
			if (event.source === "interactive") {
				pausing.talked();
				moving.typed();
			}
			return { action: "continue" };
		});
		// Whether a peer is mid-run is part of what others see of it.
		pi.on("agent_start", async () => {
			runStarted();
			peer?.setBusy(true);
			// Whatever woke a paused session, it sleeps on.
			pausing.started();
		});
		// And the step it is on, by the tool it runs, for the desktop's Busy;
		// a talk the person follows hears the step, its reply as it is
		// written, and the reply once the run settles.
		pi.on("tool_execution_start", async (event) => {
			peer?.setStep(event.toolName, toolDetail(event.args));
			talks.step(event.toolName);
		});
		// Each model call: thinking until it answers, and timed for usage.
		pi.on("turn_start", async () => {
			call = { startedAt: Date.now() };
			peer?.setThinking();
		});
		pi.on("message_update", async (event) => {
			if (event.message.role === "assistant" && call && !call.firstTokenAt) {
				call = { ...call, firstTokenAt: Date.now() };
			}
			talks.writing(assistantText(event.message));
		});
		pi.on("message_end", async (event, ctx) => {
			if (peer && event.message.role === "assistant") {
				const context = contextUsageOf(ctx);
				peer.setUsage(
					withCall(peer.usage ?? noUsage(localDay(new Date())), event.message, {
						at: new Date(),
						...call,
						...(context
							? {
									context: {
										used: context.tokens,
										limit: context.contextWindow,
									},
								}
							: {}),
					}),
				);
				call = undefined;
			}
			// The steer's own message, once in the conversation, is what
			// takes its talk into the run that answers it.
			talks.heard(userText(event.message));
			talks.wrote(assistantText(event.message));
		});
		pi.on("agent_settled", async (event) => {
			talks.settled(event.aborted);
		});
		pi.on("agent_end", async () => {
			lookAgain();
			void tidy();
			peer?.setBusy(false);
			// What the desktop's daemon found done or ready since (wait.ts).
			if (waiting) settleFromVerdicts(waiting);
			// What a run claimed is claimed only while it runs.
			own?.releaseAll(RUN_KINDS);
			// A move waiting may find the session free now.
			moving.look();
		});
		// A prompt open for the person holds a move until it closes.
		pi.on("ui_prompt_start", async () => {
			prompts += 1;
		});
		pi.on("ui_prompt_end", async () => {
			prompts = Math.max(0, prompts - 1);
			moving.look();
		});

		pi.on("session_shutdown", async (event) => {
			moving.stop();
			unhearKeys?.();
			unhearKeys = undefined;
			// What still waits is not marked read, so the next start has it.
			acts?.stop();
			clearInterval(lookClock);
			lookClock = undefined;
			clearInterval(looksClock);
			looksClock = undefined;
			// A session parking is still there to wake, so only one ending for
			// good says its items' owner has ended.
			if (waiting && !(peer && isParked(peer.session))) {
				markOwnerRunning(waiting, false);
			}
			// Ending for good moves on from its replies; a reload, a park, a
			// restart in place or a rollover carries on with them (85PKB2).
			if (
				peer &&
				endsForGood(event, {
					parked: isParked(peer.session),
					restarting: restartAsked?.restarting === true,
				})
			) {
				talks.ended();
			}
			resumes?.stop();
			clearInterval(waitClock);
			waitClock = undefined;
			clearInterval(settleClock);
			settleClock = undefined;
			if (reloading(event)) {
				// Its heavy work runs on through a reload, as its jobs do, so its
				// leases stay and the runtime the reload starts releases them.
				own?.releaseAll(RUN_KINDS);
				parkHeavyCalls(heavyCalls.held());
			} else {
				// Any other end stops the session's jobs, and its heavy work with them.
				own?.releaseAll(new Set([...RUN_KINDS, "heavy" as const]));
				unowned.length = 0;
			}
			heavyCalls.clear();
			stopWatching?.();
			stopWatching = undefined;
			untellAwaited?.();
			untellAwaited = undefined;
			unhearPresent?.();
			unhearPresent = undefined;
			steering?.stop();
			steering = undefined;
			// The peer goes with its session. Work still in flight from it, a
			// count of who is live or a message being judged, finds no peer
			// and stops: on 29 October one such refresh read the session's
			// context after a rollover had switched it out, and pi took the
			// throw as an uncaught exception 146 ms into the switch, after
			// which the session heard nothing more (and on 22 October, a
			// reload's landing note did the same).
			peer?.dispose();
			// A hosted conversation's presence goes with it, unless it parked: its
			// host is still there to wake it, and a sender finds it parked by its
			// presence (wakeParked), as it finds a plain pi that parked.
			if (hosted() && peer && !reloading(event) && !isParked(peer.session))
				presences.forget(peer.session);
			peer = undefined;
			hideWants?.();
			hideWants = undefined;
		});

		/** Claim or give up heavy work, saying so when it overlaps another's. */
		const heavy = (event: LeaseEvent) => {
			// A job carried through a reload can end before this runtime has its
			// leases; its release waits for them rather than being lost.
			if (!own && "release" in event) {
				unowned.push(event);
				return;
			}
			claim(event);
		};
		const claim = (event: LeaseEvent) =>
			void leasing
				.heavy(event)
				.then((said) => {
					if (!said) return;
					pi.sendMessage(
						{
							customType: NOTED,
							content: said,
							display: true,
							details: delivered([], []),
						},
						{ triggerTurn: false },
					);
				})
				.catch(() => {});

		// The calls a reload carried over from the runtime before this one.
		const heavyCalls = createHeavyCalls(heavy, undefined, takeHeavyCalls());
		const editNotes = createEditNotes();

		// A change claims its file, and a peer reaching for a file another is
		// changing is told who, once, before it goes ahead beside them. A git
		// command that rewrites a checkout claims it the same way, and a heavy
		// command claims its kind of work. Never throws: pi blocks a tool
		// whose handler fails.
		pi.on(
			"tool_call",
			async (event, called): Promise<ToolCallEventResult | undefined> => {
				try {
					if (isToolCallEventType("bash", event)) {
						const cwd = sessionCwd(called);
						// The command as it will run: a VM check bound for the
						// builder is no VM work here to lease (send.ts).
						const written = event.input.command;
						const command =
							typeof written === "string"
								? ((await whereItRuns(
										event.toolCallId,
										written,
										cwd,
										called?.signal,
									)) ?? written)
								: written;
						const why =
							typeof command === "string"
								? await leasing.rewrite(command, cwd)
								: undefined;
						if (why) return { block: true, reason: why };
						if (own && peer) heavyCalls.called(event.toolCallId, command);
						return undefined;
					}
					const path =
						isToolCallEventType("edit", event) ||
						isToolCallEventType("write", event)
							? event.input.path
							: undefined;
					if (typeof path !== "string" || path === "") return undefined;
					return editNotes.met(
						event.toolCallId,
						await leasing.reach(path, sessionCwd(called)),
					);
				} catch {
					return undefined;
				}
			},
		);

		pi.on("tool_result", async (event) => {
			heavyCalls.answered(event.toolCallId, event.content);
			const content = editNotes.noted(event.toolCallId, event.content);
			return content ? { content } : undefined;
		});
		if (pi.events) {
			onJobFinished(pi.events, ({ toolCallId }) => {
				if (toolCallId !== undefined) heavyCalls.finished(toolCallId);
			});
		}

		// What this session waits on its person for, as the session says it
		// over the bus. Heard from load, since a reload with a panel still
		// open says its wants again as the session starts, perhaps before
		// this peer is made; held until then.
		// What this session lands, kept in its presence; held until the peer
		// is made, as its wants are.
		if (pi.events) {
			onLanded(pi.events, (landing) => {
				if (peer) peer.landed(landing);
				else unlanded.push(landing);
				if (landing.url) resolveLooksAt(paths.looks, landing.url, "merged");
			});
			// A change closed unmerged no longer needs the person either.
			onClosed(pi.events, (url) => resolveLooksAt(paths.looks, url, "closed"));
			onUnlanded(pi.events, (ref) => {
				if (peer) peer.unlanded(ref);
				else
					unlanded.splice(0, unlanded.length, ...withoutLanding(unlanded, ref));
			});
		}

		if (pi.events) {
			onWants(pi.events, (event) => {
				if (event.said === null) {
					wanting.delete(event.kind);
					peer?.settle(event.kind);
					return;
				}
				const want = wantFrom(event);
				if (!want) return;
				wanting.set(want.kind, want);
				peer?.want(want);
			});
		}

		// A session on no model answers nothing it is sent, so its
		// orchestrator hears it from the mesh rather than from its window.
		if (pi.events) onNoModel(pi.events, tellNoModel);

		// A quest or document ended: its orchestrator hears it from the mesh,
		// not from whether the session remembers to say so.
		if (pi.events) {
			onConcluded(pi.events, (event) => {
				const message = tellOrchestrator(
					peer,
					transport,
					event,
					presences.all(),
				);
				if (message) seen.add(message.id);
				// And the talk that asked for it hears what came of it.
				for (const ref of event.ids) talks.came(ended(ref, event.how), ref);
				// What the quest asked of the person ends with it.
				endLooksOfQuests(paths.looks, (quest) => event.ids.includes(quest));
			});
		}

		// A restart in place is asked on the bus before its quit, and its
		// ask says by the shutdown whether it restarts (park-workflow).
		pi.events?.on(RESTART_ASK, (data: unknown) => {
			if (isRestartAsk(data) && peer && data.session === peer.session) {
				restartAsked = data;
			}
		});

		// A session parking says so in its presence, so senders keep what
		// they send it and wake it; one that holds others off stays.
		pi.events?.on(PARKING, (data: unknown) => {
			if (!isParking(data) || !peer || data.session !== peer.session) return;
			peer.park(data.wake);
			data.addresses = peer.addresses;
			const quest = presences.of(peer.session)?.quest;
			if (quest) data.quest = quest;
		});
		// Parking says so as it starts a session it woke, which may be before
		// or after this extension's own start: read what waited once both
		// have happened.
		pi.events?.on(SESSION_WOKEN, () => {
			woken = true;
			readWhatWaited();
		});
		pi.events?.on(PARK_ASK, (data: unknown) => {
			if (!isParkAsk(data) || !peer || data.session !== peer.session) return;
			// A restart comes back in seconds as the same peer, and what was
			// sent meanwhile waits in files it reads as it starts; refused for
			// its sessions at work, an orchestrator of thirty never took a new
			// install (WCJQSG, 11 November 2026).
			if (data.restart === true) return;
			// An orchestrator with sessions at work under it has their findings
			// coming, and passing them on is its work.
			const working = ledAtWork(peer);
			if (working) data.refusals.push(working);
			const self = { addresses: peer.addresses, ...senderIdentity() };
			const held = board
				.all()
				.flatMap((holding) => holding.leases)
				.some((lease) => {
					if (lease.kind !== "wait" || !isCurrent(lease, Date.now())) {
						return false;
					}
					const hold = transport.read(lease.subject);
					return hold !== undefined && sentBy(hold, self);
				});
			if (held) data.refusals.push("peers wait on a hold it sent");
		});
		// A session about to rest blocked asks what of its own will wake it.
		pi.events?.on(WAKERS_ASK, (data: unknown) => {
			if (!isWakersAsk(data) || !peer || data.session !== peer.session) return;
			const working = ledAtWork(peer);
			data.wakers.push(
				...(working ? [working] : []),
				...meshWakers(ownOnMesh(peer)),
			);
		});

		// Heavy work is claimed by whatever places it, over pi's bus.
		pi.events?.on(LEASE_EVENT, (data: unknown) => {
			const event = leaseEventFrom(data);
			if (event) heavy(event);
		});

		/**
		 * The sessions an orchestrator leads that are at work, said as a
		 * phrase, or nothing for any other peer or when none is.
		 */
		const ledAtWork = (one: Peer): string | undefined => {
			if (one.orchestrates === undefined) return undefined;
			// Only sessions still there, as last counted: a presence outlives
			// a pi that crashed or a boot, and on 11 November one of a quest's
			// two and a quest concluded the day before were named at work.
			const working = presences
				.all()
				.filter(
					(other) =>
						other.session !== one.session &&
						(live?.has(other.session) ?? true) &&
						ledBy(other, one.addresses) &&
						other.state !== "parked" &&
						other.state !== "paused",
				);
			if (working.length === 0) return undefined;
			const names = new Set(working.map((other) => other.addresses[0]));
			return `sessions it leads are at work (${[...names].join(", ")})`;
		};

		// A message's file never changes once it is written, so each is read
		// once here, not again each time the peer rests: the last two hours
		// were over a thousand files, 66 ms of reading on 10 November 2026.
		const recent = new Map<string, Message>();
		const readRecent = (ids: readonly string[]): Message[] => {
			const wanted = new Set(ids);
			for (const id of recent.keys()) if (!wanted.has(id)) recent.delete(id);
			return ids.flatMap((id) => {
				const kept = recent.get(id);
				if (kept) return [kept];
				const message = transport.read(id);
				if (!message) return [];
				recent.set(id, message);
				return [message];
			});
		};

		/** What the mesh holds of this peer's own, for what will wake it. */
		const ownOnMesh = (one: Peer): Own => {
			const since = Date.now() - UNANSWERED_WITHIN_MS;
			const everyone = presences.all();
			const quest = waiting?.quest();
			return {
				session: one.session,
				addresses: one.addresses,
				leases: own?.leases ?? [],
				// Ids start with the time they were sent, so older ones go unread.
				messages: readRecent(
					transport.ids().filter((id) => !(Number.parseInt(id, 10) < since)),
				),
				aliases: (address) =>
					everyone.find((peer) => peer.addresses.includes(address))
						?.addresses ?? [address],
				items: waiting && quest ? waitingOf(waiting.folder, quest) : [],
			};
		};

		/** Who waits on a hold, by the address each signs with. */
		const waitingOn = (id: string): string[] => {
			const now = Date.now();
			return board
				.all()
				.filter((holding) =>
					holding.leases.some(
						(lease) =>
							lease.kind === "wait" &&
							lease.subject === id &&
							isCurrent(lease, now),
					),
				)
				.flatMap((holding) => {
					const address = presences.of(ownerOf(holding))?.addresses[0];
					return address ? [address] : [];
				});
		};

		const local = (): Local | undefined =>
			peer
				? {
						peer,
						transport,
						presences,
						board,
						route: routing,
						queue: () => queueJobs(env),
						flows: () => flows,
						cross: (crossing) => crossAt(nodeSocket(env), crossing),
						sent: (message) => {
							seen.add(message.id);
							if (message.re !== undefined) owing.paid(message.re);
							awaiting.asked(message, peer?.addresses ?? []);
							leasing.sent(message);
							watchWaits();
							// A parked peer it gives a turn is started again to take it.
							wakeParked(
								message,
								presences.all(),
								(id) => transport.read(id),
								(session) => isParked(session),
								(session, id) => {
									askWake(session, id);
								},
							);
							// A machine hold reaches the machine's other realms too.
							try {
								cross(message, crossings, (id) => transport.read(id));
							} catch {
								// Sent here already; another realm's mesh that can't be
								// written to misses this one hold, and its holds lapse.
							}
						},
						confirmEnd: (hold, text) =>
							confirmEnd(ctx, hold, text, waitingOn(hold.id)),
						...(paths.looks ? { looks: paths.looks } : {}),
						...(waiting ? { waiting } : {}),
					}
				: undefined;
		registerTools(pi, local, () => quiet);
	};
}

/** The name the mesh carries its peer's session under across a rollover. */
const CARRY_NAME = "mesh";

/** The session a rolled-over log carried on from, as the mesh carried it. */
/**
 * Where the node serves, read from `env` alone. Made out here because
 * the connection keeps it past this load, and a closure made in
 * session_start would keep that session and its harness with it.
 */
function nodeAt(env: NodeJS.ProcessEnv): () => string | undefined {
	return () => nodeSocket(env);
}

function previousSession(carried: unknown): string | undefined {
	const session = (carried as { session?: unknown } | undefined)?.session;
	return typeof session === "string" && session !== "" ? session : undefined;
}

/**
 * The terminal window this session runs in, for its presence, or nothing
 * when no driver names one. A driver that fails to say costs only the
 * field: the desktop then finds this peer by its title, as before.
 */
function terminalOf(): { terminal?: TerminalSessionHandle } {
	try {
		const terminal = identifyCurrentTerminal();
		return terminal ? { terminal } : {};
	} catch {
		return {};
	}
}

/** A message with the attention it gets here. */
interface Heeded {
	readonly message: Message;
	readonly heed: Heed;
}

/** A question left to another peer, and which peer had it. */
interface Left extends Heeded {
	readonly by: string;
}

function answeringAt(answering: readonly boolean[], at: number): boolean {
	return answering[at] ?? false;
}

function delivered(
	messages: readonly Message[],
	glanced: readonly Message[],
	more: Pick<Delivered, "turn" | "why" | "forThisPeer"> = {},
): Delivered {
	return {
		messages,
		glanced: glanced.map((one) => one.id),
		at: Date.now(),
		...more,
	};
}

/** A glance on screen: one dim line, cut to the terminal's width. */
/** What the screen draws for a thing that is the model's alone. */
const NOTHING_SHOWN = { render: () => [], invalidate: () => {} };

/** A message's content as text, whichever shape it was sent in. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String((part as { text: unknown }).text)
				: "",
		)
		.join("\n");
}

export default meshWorkflow();
