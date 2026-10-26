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
 * answer wakes it, and a finding sent to it, or a question to a group
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
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { ownerNow } from "@jitsusama/agentic-harness.core/process";
import {
	type FoundClassifier,
	findClassifier,
} from "../../lib/classifier/jev.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import { tellAwaited } from "../../lib/internal/priority/awaited.ts";
import {
	carriedBy,
	ROLLOVER_CARRY,
} from "../../lib/internal/session/rollover.ts";
import { onWants } from "../../lib/internal/session/wants.ts";
import { onJobFinished } from "../../lib/jobs/index.ts";
import type { QuestRecords } from "../../lib/mesh/address.ts";
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
import {
	caughtUp,
	createDamper,
	MOST_CAUGHT_UP,
} from "../../lib/mesh/damping.ts";
import { groupNamed, homeOf, isJoinable } from "../../lib/mesh/group.ts";
import { isSubagent, MESH_SESSION_ENV } from "../../lib/mesh/hand.ts";
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
import { census, machineBooted } from "../../lib/mesh/liveness.ts";
import {
	asksEach,
	clock,
	isHomeTo,
	type Message,
	reaches,
	shortId,
} from "../../lib/mesh/message.ts";
import {
	ASK_AGAIN_MS,
	createAwaiting,
	createOwing,
} from "../../lib/mesh/owed.ts";
import { localPeer, type Peer } from "../../lib/mesh/peer.ts";
import { createPresences } from "../../lib/mesh/presence.ts";
import { createReadFront } from "../../lib/mesh/reading.ts";
import { sweeper } from "../../lib/mesh/retention.ts";
import type { Judge } from "../../lib/mesh/routing.ts";
import { isStopped } from "../../lib/mesh/stop.ts";
import {
	answers,
	answersQuestion,
	depthOf,
	mayReplace,
	type Self,
	sentBy,
} from "../../lib/mesh/thread.ts";
import { folderTransport, type Transport } from "../../lib/mesh/transport.ts";
import { type Want, type WantKind, wantFrom } from "../../lib/mesh/want.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
} from "../../lib/subagent/events.ts";
import { expandable } from "../../lib/ui/expandable.ts";
import { type Acts, createActs, SETTLING, type Settling } from "./acts.ts";
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
	countedIn,
	createGlances,
	type Entry,
	handedIn,
	leftToIn,
} from "./glances.ts";
import {
	createHeavyCalls,
	createLeasing,
	type HoldEnd,
	parkHeavyCalls,
	queueJobs,
	queueKept,
	reloading,
	takeHeavyCalls,
} from "./leases.ts";
import { meshLines, type Shown } from "./render.ts";
import { createSteering, type Steering, steerText } from "./steer.ts";
import { type Local, registerTools } from "./tools.ts";

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
}

/** The machine's mesh and the quest records it reads. */
export function machinePaths(): MeshPaths {
	return {
		mesh: stateDir("mesh-workflow"),
		steer: stateDir("steer"),
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
	env: NodeJS.ProcessEnv = process.env,
	settling: Settling = SETTLING,
	waitCheckMs: number = WAIT_CHECK_MS,
	lookAgainMs: number = LOOK_AGAIN_MS,
) {
	return (pi: ExtensionAPI) => {
		// Not a peer: a subagent is its parent's hands (see hand.ts).
		if (isSubagent(env)) return;
		registerHands(pi.events);
		declareGuards(GUARDS.meshEndHold);
		const transport: Transport = folderTransport(join(paths.mesh, "messages"));
		const presences = createPresences(join(paths.mesh, "presence"));
		const glances = createGlances();
		const damper = createDamper();
		const board = createBoard(join(paths.mesh, "leases"));
		// Lets go of what is past its time, at most hourly, off the turn.
		const tidy = sweeper({ transport, presences, board });
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
					pid: process.pid,
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
		const wanting = new Map<WantKind, Want>();
		let classifier: Promise<FoundClassifier> | undefined;
		let stopWatching: (() => void) | undefined;
		// Every id already looked at, so a watcher that reports one twice,
		// as inotify does for a rename, is handed over once.
		const seen = new Set<string>();
		// How far the read marker may move: only past what was handed over.
		let front = createReadFront();
		let lookClock: ReturnType<typeof setInterval> | undefined;
		let steering: Steering | undefined;

		/**
		 * The person's words from outside the window, as their own message:
		 * a turn when idle, or into the run under way, read after its tool.
		 */
		const steered = (text: string) => {
			const idle = ctx?.isIdle?.() ?? true;
			pi.sendUserMessage(text, idle ? undefined : { deliverAs: "steer" });
		};

		/** Steering for this session's addresses, when the mesh has inboxes. */
		const steer = (root: string | undefined) => {
			steering?.stop();
			steering = undefined;
			if (root === undefined) return;
			steering = createSteering({
				root,
				addresses: () => peer?.addresses ?? [],
				deliver: (one) => steered(steerText(one)),
				setAside: (inbox, names) => {
					if (!ctx?.hasUI) return;
					ctx.ui.notify(
						`Steer: set aside ${names.join(", ")} in ${inbox}, which held no text to deliver.`,
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
		 * it is a catch-up: nothing wakes, and a long one is held to what
		 * a peer starting can take in.
		 */
		const route = async (messages: readonly Message[], starting = false) => {
			if (messages.length === 0 || !ctx || !peer) return;
			peer.refresh();
			identity();
			// What it changes now tells its business from another's best.
			const receiver: Receiver = {
				...peer.receiver,
				changing: changesOf(board.of(peer.session)?.leases ?? []),
			};
			const self: Self = { addresses: peer.addresses, pid: process.pid };
			const listener = peer.listener;
			const read = (id: string) => transport.read(id);
			const everyone = presences.all();
			const stopped = messages.map((message) =>
				isStopped(message, peer?.stops ?? [], everyone),
			);
			const answering = messages.map((message) => answers(message, read, self));
			const asked = messages.map((message) =>
				answersQuestion(message, read, self),
			);
			const concerns = await Promise.all(
				messages.map((message, at) =>
					stopped[at] || answeringAt(answering, at)
						? undefined
						: judge(message, receiver),
				),
			);
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
					...(concerns[at] ? { concern: concerns[at] } : {}),
				});
				// What a starting peer catches up on rides the first prompt.
				const worth: Heed =
					starting && judged.attention === "wake"
						? { attention: "note", why: judged.why }
						: judged;
				const replaced = replacedBy(message);
				// A withdrawal reaches in full everyone who heard what it
				// withdraws, and what it withdraws is never handed over after it.
				const heard =
					replaced !== undefined && reaches(replaced, listener, process.pid);
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
				({ heed }) => heed.attention === "note" || heed.attention === "wake",
			);
			note(
				now,
				now.some(({ heed }) => heed.attention === "wake"),
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
		 * Messages in full, carrying whatever glances are waiting. A wake
		 * takes whatever waits to act with it, since it starts the turn they
		 * were waiting for.
		 */
		const note = (heeded: readonly Heeded[], wake: boolean, lead?: string) => {
			const all = wake ? [...heeded, ...unstopped(acts?.take() ?? [])] : heeded;
			if (all.length === 0) return;
			const messages = all.map(({ message }) => message);
			if (wake) leasing.answering(messages);
			for (const { message, heed } of all) {
				if (wake && heed.addressed && message.intent === "question") {
					owing.owe(message);
				}
			}
			const carried = glances.take();
			const content = noted(messages, carried);
			pi.sendMessage(
				{
					customType: NOTED,
					content: lead ? `${lead}\n\n${content}` : content,
					display: true,
					details: delivered(messages, carried, {
						turn: wake,
						why: all.map(({ heed }) => heed.why),
					}),
				},
				{ triggerTurn: wake },
			);
			handedOver(messages);
			damper.handed(messages);
			if (wake) damper.started(messages.map((one) => one.from));
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
			// A hold this peer waits on can end in a message to a group it does
			// not hear, so ends are looked for before what reaches it.
			const end = message ? leasing.ended(message) : undefined;
			if (end) resumes?.add(end);
			// Answers are counted wherever they went, so a question to a group
			// one peer took up is known as answered by every other.
			if (
				message?.re !== undefined &&
				!sentBy(message, { addresses: peer.addresses, pid: process.pid })
			) {
				answered.add(message.re);
				awaiting.answered(message.re, addressesOf(message.from));
			}
			if (!message || !reaches(message, peer.listener, process.pid)) {
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
			const again = owing.due();
			if (again.length > 0) {
				const minutes = Math.round(ASK_AGAIN_MS / 60_000);
				note(
					again.map(({ message }) => ({
						message,
						heed: {
							attention: "wake",
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
			});
			if (left.size > 0) void reconsider();
			const missed = transport
				.ids()
				.filter((id) => !seen.has(id))
				.map(take)
				.filter((one): one is Message => one !== undefined);
			if (missed.length > 0) void route(missed);
		};

		// A glance is the model's: on screen it is nothing (see render.ts).
		pi.registerEntryRenderer?.(GLANCE, () => NOTHING_SHOWN);
		pi.registerMessageRenderer?.<Shown>(NOTED, (message, options, theme) =>
			expandable(message, options.expanded, (width, expanded) =>
				meshLines(
					textOf(message.content),
					message.details,
					theme,
					width,
					expanded,
				),
			),
		);

		/**
		 * Holds this peer waited on that are over: a turn to carry on while
		 * idle, and a note mid-run. It is this peer's own work resuming, not
		 * another's interruption, so damping leaves it be; it still counts
		 * toward the hour.
		 */
		const resumed = (ends: HoldEnd[]) => {
			if (!ctx || ends.length === 0) return;
			const turn = ctx.isIdle?.() ?? false;
			const carried = glances.take();
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
				{ triggerTurn: turn },
			);
			if (turn) damper.started(ends.map(({ hold }) => hold.from));
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
			ctx = started;
			// Named on its presence so others can ask the machine whether this
			// peer is still there; a peer the machine will not name is taken
			// as there, which only costs a sender a line.
			const owner = await ownerNow().catch(() => undefined);
			const branch = (started.sessionManager.getBranch?.() ??
				[]) as readonly Entry[];
			const session = started.sessionManager.getSessionId();
			// A log rolled over into a fresh one carries on as the same peer.
			const previous = previousSession(carriedBy(branch, CARRY_NAME));
			if (previous) carryLeases(board, previous, session);
			await countLive();
			untellAwaited?.();
			untellAwaited = tellAwaited(awaited);
			// Said already before a reload is not said again.
			leftTo = leftToIn(branch);
			signed = undefined;
			peer = localPeer({
				live: () => live,
				session,
				cwd: started.cwd ?? process.cwd(),
				records: paths,
				presences,
				...(owner ? { owner } : {}),
				...(previous ? { previous } : {}),
			});
			for (const want of wanting.values()) peer.want(want);
			// Named to whatever this process starts, so a subagent knows whose
			// hands it is.
			env[MESH_SESSION_ENV] = peer.session;
			glances.recover(branch);
			const counted = countedIn(branch);
			damper.recover(counted.turns, counted.said);
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
			void route(missed, true);
			steer(paths.steer);
			identity();
			tidy();
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
		// tool results, or with the start of the next run while idle.
		pi.on("turn_end", async () => {
			leasing.stillAnswering();
			const message = glanceDigest();
			if (message) pi.sendMessage(message, { triggerTurn: false });
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
					content: noted(messages, carried),
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

		// Whether a peer is mid-run is part of what others see of it.
		pi.on("agent_start", async () => {
			peer?.setBusy(true);
		});
		pi.on("agent_end", async () => {
			lookAgain();
			tidy();
			peer?.setBusy(false);
			// What a run claimed is claimed only while it runs.
			own?.releaseAll(RUN_KINDS);
		});

		pi.on("session_shutdown", async (event) => {
			// What still waits is not marked read, so the next start has it.
			acts?.stop();
			clearInterval(lookClock);
			lookClock = undefined;
			resumes?.stop();
			clearInterval(waitClock);
			waitClock = undefined;
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
			steering?.stop();
			steering = undefined;
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
						const command = event.input.command;
						const why =
							typeof command === "string"
								? await leasing.rewrite(
										command,
										called?.cwd ?? ctx?.cwd ?? process.cwd(),
									)
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
					const why = await leasing.reach(
						path,
						called?.cwd ?? ctx?.cwd ?? process.cwd(),
					);
					return why ? { block: true, reason: why } : undefined;
				} catch {
					return undefined;
				}
			},
		);

		pi.on("tool_result", async (event) => {
			heavyCalls.answered(event.toolCallId, event.content);
			return undefined;
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

		// Heavy work is claimed by whatever places it, over pi's bus.
		pi.events?.on(LEASE_EVENT, (data: unknown) => {
			const event = leaseEventFrom(data);
			if (event) heavy(event);
		});

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

		registerTools(pi, (): Local | undefined =>
			peer
				? {
						peer,
						transport,
						presences,
						board,
						route: routing,
						queue: () => queueJobs(env),
						sent: (message) => {
							seen.add(message.id);
							if (message.re !== undefined) owing.paid(message.re);
							awaiting.asked(message, peer?.addresses ?? []);
							leasing.sent(message);
							watchWaits();
						},
						confirmEnd: (hold, text) =>
							confirmEnd(ctx, hold, text, waitingOn(hold.id)),
					}
				: undefined,
		);
	};
}

/** The name the mesh carries its peer's session under across a rollover. */
const CARRY_NAME = "mesh";

/** The session a rolled-over log carried on from, as the mesh carried it. */
function previousSession(carried: unknown): string | undefined {
	const session = (carried as { session?: unknown } | undefined)?.session;
	return typeof session === "string" && session !== "" ? session : undefined;
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
	more: Pick<Delivered, "turn" | "why"> = {},
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
