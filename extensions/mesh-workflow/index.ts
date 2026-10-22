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
 * each answered messages that needed no answer. The one exception is a
 * question this peer is the one to answer while it is idle, which starts
 * a turn, since nothing else would get it read.
 *
 * At the attention it bears, never none (lib/mesh/attention.ts). What
 * concerns this peer or the whole machine is noted in full. Another
 * peer's own business is a glance: shown on screen at once, and handed
 * to the model as one line with its next turn, whether that is the end
 * of the current step or the start of the next run.
 *
 * Every message goes to a group (lib/mesh/group.ts), never to a peer
 * alone, so what is said stays in a potentially shared space.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	type FoundClassifier,
	findClassifier,
} from "../../lib/classifier/jev.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import type { QuestRecords } from "../../lib/mesh/address.ts";
import {
	attend,
	type Concern,
	concernFrom,
	concernQuestion,
	concernState,
	type Heed,
	type Receiver,
} from "../../lib/mesh/attention.ts";
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
import { folderTransport, type Transport } from "../../lib/mesh/transport.ts";
import {
	type Delivered,
	digest,
	GLANCE,
	GLANCES,
	NOTED,
	noted,
} from "./delivery.ts";
import { createGlances, type Entry } from "./glances.ts";
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

/** The extension, on the mesh at these paths. */
export function meshWorkflow(
	paths: MeshPaths = machinePaths(),
	env: NodeJS.ProcessEnv = process.env,
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

		/** The attention each message gets here, judged together. */
		const route = async (messages: readonly Message[], mayWake = true) => {
			if (messages.length === 0 || !ctx || !peer) return;
			peer.refresh();
			const receiver = peer.receiver;
			const concerns = await Promise.all(
				messages.map((message) => judge(message, receiver)),
			);
			// Never while starting: the first prompt is about to run, and pi
			// refuses a second turn asked for beside it.
			const idle = mayWake && (ctx.isIdle?.() ?? false);
			const heeded: [Message, Heed][] = messages.map((message, at) => [
				message,
				attend(message, {
					receiver,
					idle,
					...(concerns[at] ? { concern: concerns[at] } : {}),
				}),
			]);
			for (const [message, heed] of heeded) {
				if (heed.attention !== "glance") continue;
				pi.appendEntry(GLANCE, { message, why: heed.why });
				glances.add(message);
			}
			const kept = heeded.filter(([, heed]) => heed.attention !== "glance");
			note(
				kept.map(([message]) => message),
				kept.some(([, heed]) => heed.attention === "wake"),
			);
		};

		/** Messages in full, carrying whatever glances are waiting. */
		const note = (messages: readonly Message[], wake: boolean) => {
			if (messages.length === 0) return;
			const carried = glances.take();
			pi.sendMessage(
				{
					customType: NOTED,
					content: noted(messages, carried),
					display: true,
					details: delivered(messages, carried),
				},
				{ triggerTurn: wake },
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
			if (!message || !reaches(message, peer.listener, process.pid)) {
				return undefined;
			}
			transport.markRead(peer.signature, id);
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

		pi.on("session_start", async (_event, started) => {
			ctx = started;
			peer = localPeer({
				session: started.sessionManager.getSessionId(),
				cwd: started.cwd ?? process.cwd(),
				records: paths,
				presences,
			});
			glances.recover(
				(started.sessionManager.getBranch?.() ?? []) as readonly Entry[],
			);
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
		pi.on("before_agent_start", async () => {
			const message = glanceDigest();
			return message ? { message } : undefined;
		});

		pi.on("session_shutdown", async () => {
			stopWatching?.();
			stopWatching = undefined;
		});

		registerTools(pi, (): Local | undefined =>
			peer
				? {
						peer,
						transport,
						presences,
						sent: (message) => seen.add(message.id),
					}
				: undefined,
		);
	};
}

function delivered(
	messages: readonly Message[],
	glanced: readonly Message[],
): Delivered {
	return { messages, glanced: glanced.map((one) => one.id) };
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
