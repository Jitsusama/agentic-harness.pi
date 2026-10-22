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

import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ownerNow } from "@jitsusama/agentic-harness.core/process";
import {
	type FoundClassifier,
	findClassifier,
} from "../../lib/classifier/jev.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import { onJobFinished } from "../../lib/jobs/index.ts";
import type { QuestRecords } from "../../lib/mesh/address.ts";
import {
	attend,
	type Concern,
	concernFrom,
	concernQuestion,
	concernState,
	type Heed,
	mentions,
	type Receiver,
} from "../../lib/mesh/attention.ts";
import { createDamper } from "../../lib/mesh/damping.ts";
import { groupNamed, isJoinable } from "../../lib/mesh/group.ts";
import {
	createBoard,
	heavyWorkIn,
	LEASE_EVENT,
	type LeaseEvent,
	leaseEventFrom,
	type OwnLeases,
	ownLeases,
	RUN_KINDS,
} from "../../lib/mesh/lease.ts";
import {
	bridgePresences,
	bridgeTransport,
	LEGACY_GLANCE,
	legacyGlance,
} from "../../lib/mesh/legacy.ts";
import {
	isHomeTo,
	line,
	type Message,
	reaches,
} from "../../lib/mesh/message.ts";
import { localPeer, type Peer } from "../../lib/mesh/peer.ts";
import { createPresences } from "../../lib/mesh/presence.ts";
import { sweeper } from "../../lib/mesh/retention.ts";
import type { Judge } from "../../lib/mesh/routing.ts";
import { isStopped } from "../../lib/mesh/stop.ts";
import {
	answers,
	depthOf,
	mayReplace,
	type Self,
	sentBy,
} from "../../lib/mesh/thread.ts";
import { folderTransport, type Transport } from "../../lib/mesh/transport.ts";
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
import { countedIn, createGlances, type Entry } from "./glances.ts";
import { createLeasing, type HoldEnd } from "./leases.ts";
import { type Local, registerTools } from "./tools.ts";

/**
 * The environment variable naming the classifier that judges messages
 * as `provider/model`, or `off` to note everything.
 */
export const MESH_CLASSIFIER_ENV = "PI_MESH_CLASSIFIER";

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
 * How the shell tool answers a call it handed to a job (see
 * shell-workflow's hand-off), whose command runs on past its answer.
 */
const HANDED_OFF = /in the background as job \S+/;

/** A command's first line, as a lease says what it is for. */
function commandLine(command: string): string {
	const first = command.trim().split("\n")[0] ?? "";
	return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

/** Why a stopped peer's message is a glance, whatever it was. */
const STOPPED = "from a peer this one stopped";

/** Where the mesh and the quest records live; the defaults are the machine's. */
export interface MeshPaths extends QuestRecords {
	/** The mesh's own state: its messages and every peer's presence. */
	readonly mesh: string;
	/** The legacy mailbox, bridged until no peer speaks it. */
	readonly legacy: string;
}

/** The machine's mesh, and the legacy mailbox where it always was. */
export function machinePaths(): MeshPaths {
	const state = process.env.XDG_STATE_HOME;
	return {
		mesh: stateDir("mesh-workflow"),
		legacy: join(
			state && state.length > 0 ? state : join(homedir(), ".local", "state"),
			"pi-mailbox",
		),
		sessions: join(stateDir("quest-workflow"), "sessions"),
		quests: join(dataDir("quest-workflow"), "quests"),
	};
}

/**
 * Whether this pi is a fleet's subagent, which the supervisor marks in
 * the environment it starts the child with.
 *
 * A subagent is a worker inside another session's turn, answering to
 * that session alone: on the mesh it would be handed the machine's
 * coordination in the middle of its one job, and would show up as a
 * peer other senders reach.
 */
export function isSubagent(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SUBAGENT_SUPERVISOR === "1" || Boolean(env.SUBAGENT_RUN_ID);
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
) {
	return (pi: ExtensionAPI) => {
		// Not on the mesh at all: see isSubagent.
		if (isSubagent(env)) return;
		const transport: Transport = bridgeTransport(
			folderTransport(join(paths.mesh, "messages")),
			paths.legacy,
		);
		const presences = bridgePresences(
			createPresences(join(paths.mesh, "presence")),
			paths.legacy,
		);
		const glances = createGlances();
		const damper = createDamper();
		const board = createBoard(join(paths.mesh, "leases"));
		// Lets go of what is past its time, at most hourly, off the turn.
		const tidy = sweeper({ transport, presences, board });
		let own: OwnLeases | undefined;
		const leasing = createLeasing({
			board,
			presences,
			transport,
			own: () => own,
			peer: () => peer,
			sent: (message) => seen.add(message.id),
		});
		// Holds this peer waited on that are over, waiting to settle as acts
		// do, so peers held by one hold do not all carry on at once.
		let resumes: Acts<HoldEnd> | undefined;
		let waitClock: ReturnType<typeof setInterval> | undefined;
		let acts: Acts<Heeded> | undefined;
		// Messages other peers have answered, so a question to a group that
		// one peer took up starts no turn of the rest.
		const answered = new Set<string>();
		let ctx: ExtensionContext | undefined;
		let peer: Peer | undefined;
		let classifier: Promise<FoundClassifier> | undefined;
		let stopWatching: (() => void) | undefined;
		// Every id already looked at, so a watcher that reports one twice,
		// as inotify does for a rename, or a message seen in both the mesh
		// and the legacy folder, is handed over once.
		const seen = new Set<string>();

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
						questions: concernQuestion,
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

		/** The attention each message gets here, judged together. */
		const route = async (messages: readonly Message[], mayWake = true) => {
			if (messages.length === 0 || !ctx || !peer) return;
			peer.refresh();
			const receiver = peer.receiver;
			const self: Self = { addresses: peer.addresses, pid: process.pid };
			const listener = peer.listener;
			const read = (id: string) => transport.read(id);
			const everyone = presences.all();
			const stopped = messages.map((message) =>
				isStopped(message, peer?.stops ?? [], everyone),
			);
			const answering = messages.map((message) => answers(message, read, self));
			const concerns = await Promise.all(
				messages.map((message, at) =>
					stopped[at] || answeringAt(answering, at)
						? undefined
						: judge(message, receiver),
				),
			);
			// Never while starting: the first prompt is about to run, and pi
			// refuses a second turn asked for beside it.
			const idle = mayWake && (ctx.isIdle?.() ?? false);
			const damped: string[] = [];
			const heeded: Heeded[] = messages.map((message, at) => {
				// Stopped is absolute: a line, never more, whatever it is.
				if (stopped[at]) {
					return {
						message,
						heed: { attention: "glance", why: STOPPED },
					};
				}
				const worth = attend(message, {
					receiver,
					idle,
					answers: answeringAt(answering, at),
					...(concerns[at] ? { concern: concerns[at] } : {}),
				});
				const replaced = replacedBy(message);
				// A withdrawal reaches in full everyone who heard what it
				// withdraws, and what it withdraws is never handed over after it.
				const heard =
					replaced !== undefined && reaches(replaced, listener, process.pid);
				if (replaced) {
					glances.drop(replaced.id);
					acts?.drop((one) => one.message.id === replaced.id);
				}
				const raised: Heed =
					heard && worth.attention === "glance"
						? { attention: "note", why: "replacing what this peer heard" }
						: worth;
				const heed = damper.damp(message, raised, depthOf(message, read));
				if (heed.attention !== raised.attention) damped.push(heed.why);
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
			ctx.ui.notify(`Mesh: held back (${damped.join("; ")})`, "info");
		};

		/** A line on screen now, and for the model with its next turn. */
		const glance = (message: Message, why: string) => {
			pi.appendEntry(GLANCE, { message, why });
			glances.add(message);
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
		const note = (heeded: readonly Heeded[], wake: boolean) => {
			const all = wake ? [...heeded, ...unstopped(acts?.take() ?? [])] : heeded;
			if (all.length === 0) return;
			const messages = all.map(({ message }) => message);
			if (wake) leasing.answering(messages);
			const carried = glances.take();
			pi.sendMessage(
				{
					customType: NOTED,
					content: noted(messages, carried),
					display: true,
					details: delivered(messages, carried, {
						turn: wake,
						why: all.map(({ heed }) => heed.why),
					}),
				},
				{ triggerTurn: wake },
			);
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
			// A question another peer has a turn for is left to it.
			const answerers = await Promise.all(
				waiting.map(({ message }) =>
					message.intent === "question"
						? leasing.answeredBy(message).catch(() => undefined)
						: undefined,
				),
			);
			if (!ctx || !peer) return;
			const read = (id: string) => transport.read(id);
			const idle = ctx.isIdle?.() ?? false;
			const damped: string[] = [];
			const now = waiting.map(({ message, heed }, at): Heeded => {
				if (answered.has(message.id) && message.intent === "question") {
					return {
						message,
						heed: { attention: "note", why: `${heed.why}, answered already` },
					};
				}
				const answerer = answerers[at];
				if (answerer !== undefined) {
					return {
						message,
						heed: {
							attention: "note",
							why: `${heed.why}, being answered by ${answerer}`,
						},
					};
				}
				if (!idle)
					return { message, heed: { attention: "note", why: heed.why } };
				const held = damper.damp(message, heed, depthOf(message, read));
				if (held.attention !== heed.attention) damped.push(held.why);
				return { message, heed: held };
			});
			say(damped);
			const turn = now.some(({ heed }) => heed.attention === "act");
			note(
				now.map(({ message, heed }) => ({
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
			}
			if (!message || !reaches(message, peer.listener, process.pid)) {
				return undefined;
			}
			transport.markRead(peer.signature, id);
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

		pi.registerEntryRenderer?.<{ message: Message }>(
			GLANCE,
			(entry, _options, theme) => glanceView(entry.data?.message, theme),
		);
		// Sessions that glanced before the mesh still show what they saw.
		pi.registerEntryRenderer?.(LEGACY_GLANCE, (entry, _options, theme) =>
			glanceView(legacyGlance(entry.data), theme),
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
			if (isEphemeral(started.sessionManager)) return;
			ctx = started;
			// Named on its presence so others can ask the machine whether this
			// peer is still there; a peer the machine will not name is taken
			// as there, which only costs a sender a line.
			const owner = await ownerNow().catch(() => undefined);
			peer = localPeer({
				session: started.sessionManager.getSessionId(),
				cwd: started.cwd ?? process.cwd(),
				records: paths,
				presences,
				...(owner ? { owner } : {}),
			});
			const branch = (started.sessionManager.getBranch?.() ??
				[]) as readonly Entry[];
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
			void route(missed, false);
			tidy();
			stopWatching?.();
			stopWatching = undefined;
			try {
				stopWatching = transport.watch((id) => {
					const message = take(id);
					if (message) void route([message]);
				});
			} catch (error) {
				// A transport that cannot be watched leaves this peer deaf,
				// which nothing else would show.
				if (started.hasUI) {
					started.ui.notify(
						`Mesh: cannot watch for messages (${error instanceof Error ? error.message : String(error)}), so they will arrive only at this session's next start.`,
						"warning",
					);
				}
			}
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

		// Whether a peer is mid-run is part of what others see of it.
		pi.on("agent_start", async () => {
			peer?.setBusy(true);
		});
		pi.on("agent_end", async () => {
			tidy();
			peer?.setBusy(false);
			// What a run claimed is claimed only while it runs.
			own?.releaseAll(RUN_KINDS);
		});

		pi.on("session_shutdown", async () => {
			acts?.stop();
			resumes?.stop();
			clearInterval(waitClock);
			waitClock = undefined;
			// Its heavy work ends with it: pi stops a session's jobs as it goes.
			own?.releaseAll(new Set([...RUN_KINDS, "heavy" as const]));
			heavyCalls.clear();
			stopWatching?.();
			stopWatching = undefined;
		});

		/** Claim or give up heavy work, saying so when it overlaps another's. */
		const heavy = (event: LeaseEvent) =>
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

		// The heavy shell commands running, by call, so work two calls share
		// is given up only when the last of them ends.
		const heavyCalls = new Map<string, string>();

		// A change claims its file, and a peer reaching for a file another is
		// changing is told who, once, before it goes ahead beside them. A heavy
		// command claims its kind of work. Never throws: pi blocks a tool
		// whose handler fails.
		pi.on(
			"tool_call",
			async (event, called): Promise<ToolCallEventResult | undefined> => {
				try {
					if (isToolCallEventType("bash", event)) {
						const command = event.input.command;
						const subject =
							typeof command === "string" ? heavyWorkIn(command) : undefined;
						if (subject && own && peer) {
							heavyCalls.set(event.toolCallId, subject);
							heavy({ take: { subject, why: commandLine(command) } });
						}
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

		/** A heavy command has ended: its work is given up with its last. */
		const ended = (toolCallId: string) => {
			const subject = heavyCalls.get(toolCallId);
			if (subject === undefined) return;
			heavyCalls.delete(toolCallId);
			if (![...heavyCalls.values()].includes(subject)) {
				heavy({ release: subject });
			}
		};

		// A heavy command's work is over when its call answers, unless the
		// call handed it to a job, which runs on past the answer until the
		// job says it has ended.
		pi.on("tool_result", async (event) => {
			const handedOff = event.content.some(
				(part) => part.type === "text" && HANDED_OFF.test(part.text),
			);
			if (!handedOff) ended(event.toolCallId);
			return undefined;
		});
		if (pi.events) {
			onJobFinished(pi.events, ({ toolCallId }) => {
				if (toolCallId !== undefined) ended(toolCallId);
			});
		}

		// Heavy work is claimed by whatever places it, over pi's bus.
		pi.events?.on(LEASE_EVENT, (data: unknown) => {
			const event = leaseEventFrom(data);
			if (event) heavy(event);
		});

		registerTools(pi, (): Local | undefined =>
			peer
				? {
						peer,
						transport,
						presences,
						board,
						route: routing,
						sent: (message) => {
							seen.add(message.id);
							leasing.sent(message);
							watchWaits();
						},
					}
				: undefined,
		);
	};
}

/** A message with the attention it gets here. */
interface Heeded {
	readonly message: Message;
	readonly heed: Heed;
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
function glanceView(
	message: Message | undefined,
	theme: { fg: (role: "dim", text: string) => string },
) {
	if (!message) return undefined;
	const text = `Mesh glance: ${line(message)}`;
	return {
		render: (width: number) => [theme.fg("dim", truncateToWidth(text, width))],
		invalidate: () => {},
	};
}

export default meshWorkflow();
