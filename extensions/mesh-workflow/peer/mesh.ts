/**
 * What every part of a peer shares: the paths and settings it runs with,
 * the state its parts read and change, and the shapes they pass along.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_ENV,
	type FoundClassifier,
} from "../../../lib/classifier/jev.ts";
import type { ConcludedEvent } from "../../../lib/internal/quest/fields/concluded.ts";
import type { createReloadHold } from "../../../lib/internal/reload/hold.ts";
import type { SessionEvent } from "../../../lib/internal/session/events.ts";
import type { Landing } from "../../../lib/internal/session/landings.ts";
import type { NoModelEvent } from "../../../lib/internal/session/no-model.ts";
import type { RestartAsk } from "../../../lib/internal/session/park.ts";
import type { QuestRecords } from "../../../lib/mesh/address.ts";
import { FYI_MS, type Heed } from "../../../lib/mesh/attention.ts";
import type { Crossings } from "../../../lib/mesh/crossing.ts";
import type { createDamper } from "../../../lib/mesh/damping.ts";
import type {
	createBoard,
	LeaseEvent,
	OwnLeases,
} from "../../../lib/mesh/lease.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import type { createAwaiting, createOwing } from "../../../lib/mesh/owed.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import type { createPresences, Presence } from "../../../lib/mesh/presence.ts";
import type { createReadFront } from "../../../lib/mesh/reading.ts";
import type { sweeper } from "../../../lib/mesh/retention.ts";
import type { Transport } from "../../../lib/mesh/transport.ts";
import type { Want, WantKind } from "../../../lib/mesh/want.ts";
import type { Acts, Settling } from "../acts.ts";
import type { Delivered } from "../delivery.ts";
import type { createGlances } from "../glances.ts";
import type { handOverOf } from "../in-place.ts";
import type { createLeasing, HoldEnd, TakenCall } from "../leases.ts";
import type { createMoving } from "../moving.ts";
import type { createOrderedCarrying } from "../ordered-carry.ts";
import type { createPausing } from "../pausing.ts";
import type { Steering } from "../steer.ts";
import type { createTalks } from "../talks.ts";
import type { HubTiming, KeptHub } from "../tools/above.ts";
import type { Waiting, watchSettling } from "../wait.ts";

/**
 * The environment variable naming the classifier that judges messages
 * as `provider/model`, or `off` to note everything. Replies to the
 * person are judged by the one it names too (`reply-cause-interceptor`).
 */
export const MESH_CLASSIFIER_ENV = CLASSIFIER_ENV;

/**
 * The environment variable that keeps a session off the mesh when
 * `off`: it joins no group, hears nothing and claims nothing, as a
 * session kept nowhere does. A session on a small personal plan uses
 * it, since every hold and question on the machine could otherwise
 * start a turn on that plan's allowance.
 */
export const MESH_ENV = "PI_MESH";

/** Whether `sender` is a session `addresses` orchestrate, as its presence says. */
export function ledBy(
	sender: Pick<Presence, "orchestratedBy"> | undefined,
	addresses: readonly string[],
): boolean {
	return (
		sender?.orchestratedBy !== undefined &&
		addresses.includes(sender.orchestratedBy)
	);
}

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

/** Why a stopped peer's message is a glance, whatever it was. */
export const STOPPED = "from a peer this one stopped";

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
	 * look list reads it (lib/mesh/looks/looks.ts); none, and show_person keeps
	 * nothing.
	 */
	readonly looks?: string;
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

/** A message with the attention it gets here. */
export interface Heeded {
	readonly message: Message;
	readonly heed: Heed;
}

/** A question left to another peer, and which peer had it. */
export interface Left extends Heeded {
	readonly by: string;
}

/** Whether the message at `at` answers, as `answering` says. */
export function answeringAt(
	answering: readonly boolean[],
	at: number,
): boolean {
	return answering[at] ?? false;
}

/** What a delivery carries for its renderer: the messages, the glances and when. */
export function delivered(
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

/**
 * One peer's state, shared by every part of it: made once as the
 * extension loads, and read and changed by its handlers, so each part
 * sees what the others did.
 */
export interface MeshState {
	readonly pi: ExtensionAPI;
	readonly paths: MeshPaths;
	readonly env: NodeJS.ProcessEnv;
	readonly settling: Settling;
	readonly waitCheckMs: number;
	readonly lookAgainMs: number;
	// How often the hub from use is found again (tools/above.ts).
	readonly hubTiming: HubTiming;
	own: OwnLeases | undefined;
	// The sessions last counted still there, so a quest's address is
	// left only to a peer that is (see address.ts).
	live: ReadonlySet<string> | undefined;
	untellAwaited: (() => void) | undefined;
	// The realms this one may send to, as the node last said; asked as
	// the session starts and again each time the node counts this
	// process present anew, as after it restarts (see lib/mesh/flow.ts).
	flows: Promise<readonly string[]>;
	unhearPresent: (() => void) | undefined;
	// Whose quest address this peer was told it left, and what it last
	// signed as, so each is said once.
	leftTo: string | undefined;
	signed: string | undefined;
	// Holds this peer waited on that are over, waiting to settle as acts
	// do, so peers held by one hold do not all carry on at once.
	resumes: Acts<HoldEnd> | undefined;
	waitClock: ReturnType<typeof setInterval> | undefined;
	acts: Acts<Heeded> | undefined;
	ctx: ExtensionContext | undefined;
	peer: Peer | undefined;
	// Whether this session keeps peers' news off its screen, and how many
	// messages it keeps off now (see quiet.ts).
	quiet: boolean;
	keptOff: number;
	// Woken from parking, this session reads what waited once its
	// catch-up is done; either can come first, since parking says so
	// from its own start (see readWhatWaited).
	woken: boolean;
	startCaughtUp: boolean;
	// A turn was asked for since this start, so what waited is read.
	turnAsked: boolean;
	// Messages handed over since this start without a turn.
	handedNow: number;
	// The model call under way, timed for the usage presence says.
	call: { startedAt: number; firstTokenAt?: number } | undefined;
	// While a peer stands, its presence shows this session's wants, so
	// nothing else need notify the person of them (wants.ts).
	hideWants: (() => void) | undefined;
	settleClock: ReturnType<typeof setInterval> | undefined;
	// A session on no model is said at its start, perhaps before this
	// peer is made, and before every turn after: held until then, and
	// told once.
	onNoModelUntold: NoModelEvent | undefined;
	toldOnNoModel: boolean;
	// Quests and documents that ended while nobody was above to hear it,
	// the newest, each with the quest the session was on, told once a hub
	// is kept if the session is on that quest still.
	endingsUntold: readonly {
		readonly event: ConcludedEvent;
		readonly quest: string | undefined;
	}[];
	classifier: Promise<FoundClassifier> | undefined;
	stopWatching: (() => void) | undefined;
	// Where this peer's catch-up began: a message stamped at or before it
	// was this peer's to read then, so one that turns up later is an old
	// copy and never a turn (see take).
	caughtUpFrom: string | undefined;
	// How far the read marker may move: only past what was handed over.
	front: ReturnType<typeof createReadFront>;
	lookClock: ReturnType<typeof setInterval> | undefined;
	// This peer's hub from use, kept for what the mesh says by itself on
	// a quest with no mark (tools/above.ts).
	hub: KeptHub | undefined;
	// Asking GitHub about the person's looks at pull requests, a turn
	// across every session (lib/mesh/looks/github.ts).
	looksClock: ReturnType<typeof setInterval> | undefined;
	steering: Steering | undefined;
	/** Where the steer inboxes are, once the mesh says. */
	steerRoot: string | undefined;
	/** The last restart in place asked of this session, if any. */
	restartAsked: RestartAsk | undefined;
	// Prompts open for the person, which a move waits out.
	prompts: number;
	// When a key was last pressed in this window, which a move in place
	// waits to go quiet.
	keyedAt: number;
	unhearKeys: (() => void) | undefined;
	// The host this conversation runs in, by key, read where hosted() knows.
	hostKey: string | undefined;
	// Reads a message under a receptor's name as nothing.
	readonly transport: Transport;
	// Reads one as it lies, for the readers that ask the node to vouch.
	readonly asWritten: (id: string) => Message | undefined;
	// The same, read off the thread, for mesh_read.
	readonly asWrittenOff: (id: string) => Promise<Message | undefined>;
	readonly presences: ReturnType<typeof createPresences>;
	readonly glances: ReturnType<typeof createGlances>;
	readonly damper: ReturnType<typeof createDamper>;
	readonly board: ReturnType<typeof createBoard>;
	readonly crossings: Crossings;
	readonly tidy: ReturnType<typeof sweeper>;
	readonly unowned: LeaseEvent[];
	readonly takenUnowned: TakenCall[];
	readonly leasing: ReturnType<typeof createLeasing>;
	readonly answered: Set<string>;
	readonly left: Map<string, Left>;
	readonly owing: ReturnType<typeof createOwing>;
	readonly awaiting: ReturnType<typeof createAwaiting>;
	readonly waiting: Waiting | undefined;
	readonly settleWatch: ReturnType<typeof watchSettling> | undefined;
	readonly wanting: Map<WantKind, Want>;
	readonly unlanded: Landing[];
	readonly undone: SessionEvent[];
	readonly seen: Set<string>;
	// Why the claim check judged nothing, each said once a session.
	readonly unjudgedSaid: Set<string>;
	readonly holdTurn: ReturnType<typeof createReloadHold>;
	readonly talks: ReturnType<typeof createTalks>;
	readonly pausing: ReturnType<typeof createPausing>;
	readonly handOver: () => ReturnType<typeof handOverOf> | undefined;
	readonly ordering: ReturnType<typeof createOrderedCarrying>;
	readonly moving: ReturnType<typeof createMoving>;
}
