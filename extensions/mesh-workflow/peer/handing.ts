/**
 * Handing messages to the model: in full or as a glance, with a turn or
 * without, and what waited once the mesh settles or a hold ends.
 */

import type { ConcludedEvent } from "../../../lib/internal/quest/fields/concluded.ts";
import {
	HOLD_FOR_RELOAD_MS,
	oweTurnToReload,
	takeOwedTurn,
} from "../../../lib/internal/reload/hold.ts";
import { firstPromptPending } from "../../../lib/internal/session/first-prompt.ts";
import type { NoModelEvent } from "../../../lib/internal/session/no-model.ts";
import { asksEach, type Message } from "../../../lib/mesh/message.ts";
import { isStopped } from "../../../lib/mesh/stop.ts";
import { depthOf } from "../../../lib/mesh/thread.ts";
import {
	digest,
	GLANCE,
	GLANCES,
	holdsOver,
	NOTED,
	noted,
} from "../delivery.ts";
import type { HoldEnd } from "../leases.ts";
import { folds, QUIET_STATUS, quietStatus } from "../quiet.ts";
import { tellOnNoModel, tellOrchestrator } from "../tells.ts";
import { keptAbove } from "../tools/above.ts";
import { delivered, type Heeded, type MeshState, STOPPED } from "./mesh.ts";

/**
 * What starts the turn a note put off for a reload, when no reload came
 * to start it.
 */
const TURN_PUT_OFF =
	"The mesh messages above reached you while a reload of your harness waited. Act on them now.";

/**
 * How many endings a session keeps, the newest, while it has nobody to
 * tell them to: enough for a spell with no hub, and bounded for a session
 * that never finds one.
 */
const ENDINGS_KEPT = 10;

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

/** How this peer hands what reached it to its model. */
export function createHanding(m: MeshState) {
	const showQuiet = () => {
		if (!m.ctx?.hasUI) return;
		m.ctx.ui.setStatus(
			QUIET_STATUS,
			m.quiet ? quietStatus(m.keptOff, m.ctx.ui.theme) : undefined,
		);
	};

	const tellNoModel = (event: NoModelEvent) => {
		if (m.toldOnNoModel) return;
		if (!m.peer) {
			m.onNoModelUntold = event;
			return;
		}
		const above = keptAbove(m.peer.orchestratedBy, m.hub)?.address;
		// No hub found yet on a quest with no mark: kept until one is
		// (start.ts), rather than counted told when nobody heard it.
		if (above === undefined) {
			m.onNoModelUntold = event;
			return;
		}
		m.onNoModelUntold = event;
		const message = tellOnNoModel(
			m.peer,
			above,
			m.transport,
			event,
			m.presences.all(),
		);
		// Counted told only once it was, so one that threw is kept and tried
		// again at the next find.
		m.toldOnNoModel = true;
		m.onNoModelUntold = undefined;
		if (message) m.seen.add(message.id);
	};

	/**
	 * Tell this peer's orchestrator that a quest or document ended, with
	 * what waited before it. On a quest with no mark and no hub kept yet,
	 * as after the node was down, it waits until a find keeps one
	 * (start.ts) rather than going nowhere; with no event, what waited is
	 * told. Each is kept with the quest it ended under, and told only while
	 * the session is still on it, since the hub of a quest it moved to
	 * would hear of work that is not under it.
	 */
	const tellConcluded = (event?: ConcludedEvent) => {
		const quest = m.peer?.quest;
		const waiting = [
			...m.endingsUntold,
			...(event === undefined ? [] : [{ event, quest }]),
		].slice(-ENDINGS_KEPT);
		const above = keptAbove(m.peer?.orchestratedBy, m.hub)?.address;
		if (m.peer === undefined || above === undefined) {
			m.endingsUntold = waiting;
			return;
		}
		m.endingsUntold = waiting.filter((one) => one.quest === quest);
		for (const one of [...m.endingsUntold]) {
			const message = tellOrchestrator(
				m.peer,
				above,
				m.transport,
				one.event,
				m.presences.all(),
			);
			// Taken off only once told, so a tell that throws leaves it and
			// the rest for the next find.
			m.endingsUntold = m.endingsUntold.slice(1);
			if (message) m.seen.add(message.id);
		}
	};

	/**
	 * Whether the turn a note would start is put off for a waiting
	 * reload. If no reload takes it within the hold, the note's own turn
	 * starts then; a run under way by then reads the note, so the turn is
	 * taken and nothing more is started.
	 */
	const putOffTurn = (): boolean => {
		if (!m.holdTurn()) return false;
		oweTurnToReload();
		const due = () => {
			let idle = false;
			try {
				idle = m.ctx?.isIdle?.() ?? false;
			} catch {
				// A stale context: the reload landed, and its landing took the turn.
				return;
			}
			if (!takeOwedTurn() || !idle) return;
			try {
				m.pi.sendMessage(
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

	/** These were handed over, or need nothing more: the marker follows. */
	const handedOver = (messages: readonly Message[]) => {
		const to = m.front.handed(messages.map((one) => one.id));
		if (to !== undefined && m.peer) m.transport.markRead(m.peer.signature, to);
	};

	/** Damping said on screen, where the person sees it and the model not. */
	const say = (damped: readonly string[]) => {
		if (damped.length === 0 || !m.ctx?.hasUI) return;
		m.ctx.ui.notify(
			`Mesh: held back (${[...new Set(damped)].join("; ")})`,
			"info",
		);
	};

	/** A line on screen now, and for the model with its next turn. */
	const glance = (message: Message, why: string) => {
		m.pi.appendEntry(GLANCE, { message, why });
		m.glances.add(message);
		// Recorded in the session, so a reload finds it waiting still.
		handedOver([message]);
	};

	/**
	 * What waited to act, less what came from a peer stopped since: a
	 * stop reaches what is already waiting, which becomes a glance.
	 */
	const unstopped = (waiting: readonly Heeded[]): Heeded[] => {
		const everyone = m.presences.all();
		return waiting.filter(({ message }) => {
			if (!isStopped(message, m.peer?.stops ?? [], everyone)) return true;
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
		const turn = asked && !m.pausing.paused;
		const all = turn ? [...heeded, ...unstopped(m.acts?.take() ?? [])] : heeded;
		if (all.length === 0) return;
		const messages = all.map(({ message }) => message);
		if (turn) m.leasing.answering(messages);
		for (const { message, heed } of all) {
			if (
				turn &&
				heed.addressed &&
				message.intent === "question" &&
				// No answer reaches back to another realm, so none is owed.
				message.fromRealm === undefined
			) {
				m.owing.owe(message);
			}
		}
		const carried = m.glances.take();
		const content = noted(
			messages,
			carried,
			keptAbove(m.peer?.orchestratedBy, m.hub),
		);
		// What asked for a turn, or answers this peer, shows on a quiet
		// screen though a pause held its turn back.
		const forThisPeer =
			asked || all.some(({ heed }) => heed.awaited || heed.addressed);
		// pi's own first prompt, still to come, is the turn that reads it.
		const putOff = turn && (firstPromptPending() || putOffTurn());
		if (turn) m.turnAsked = true;
		else m.handedNow += messages.length;
		m.pi.sendMessage(
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
		if (m.quiet && folds({ messages, turn, forThisPeer })) {
			m.keptOff += messages.length;
			showQuiet();
		}
		handedOver(messages);
		m.damper.handed(messages);
	};

	/**
	 * What waited to act, once the mesh has settled: a turn for what is
	 * still worth one and affordable, and a note for the rest, such as a
	 * group's question another peer has answered meanwhile.
	 */
	const settled = async (arrived: Heeded[]) => {
		if (!m.ctx || !m.peer) return;
		const waiting = unstopped(arrived);
		// A question another peer has a turn for is left to it, unless it
		// asks each peer, when another's answer is not this one's.
		const listener = m.peer.listener;
		const each = waiting.map(({ message }) => asksEach(message, listener));
		const answerers = await Promise.all(
			waiting.map(({ message }, at) =>
				message.intent === "question" && !each[at]
					? m.leasing.answeredBy(message).catch(() => undefined)
					: undefined,
			),
		);
		if (!m.ctx || !m.peer) return;
		const read = (id: string) => m.transport.read(id);
		const idle = m.ctx.isIdle?.() ?? false;
		const damped: string[] = [];
		const now = waiting.map(({ message, heed }, at): Heeded => {
			if (
				m.answered.has(message.id) &&
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
				m.left.set(message.id, { message, heed, by: answerer });
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
			const held = m.damper.damp(message, heed, depthOf(message, read));
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
		const carried = m.glances.take();
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

	/**
	 * Holds this peer waited on that are over: a turn to carry on while
	 * idle, and a note mid-run. It is this peer's own work resuming, not
	 * another's interruption, so damping leaves it be.
	 */
	const resumed = (ends: HoldEnd[]) => {
		if (!m.ctx || ends.length === 0) return;
		const turn = (m.ctx.isIdle?.() ?? false) && !m.pausing.paused;
		const carried = m.glances.take();
		const putOff = turn && (firstPromptPending() || putOffTurn());
		m.pi.sendMessage(
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
		if (!m.woken || !m.startCaughtUp || !m.ctx) return;
		m.woken = false;
		// A first prompt to come, a run under way, or an act's turn held
		// for the mesh to settle, reads them itself.
		if (
			m.turnAsked ||
			m.pausing.paused ||
			firstPromptPending() ||
			(m.acts?.pending() ?? false)
		) {
			return;
		}
		let waiting = 0;
		try {
			if (!(m.ctx.isIdle?.() ?? false)) return;
			waiting =
				m.handedNow +
				handedSinceLastTurn(m.ctx.sessionManager.getBranch?.() ?? []);
		} catch {
			// A stale context: a reload replaced it, and its start reads afresh.
			return;
		}
		if (waiting === 0) return;
		m.turnAsked = true;
		m.pi.sendMessage(
			{ customType: NOTED, content: WOKEN_TO_READ, display: true },
			{ triggerTurn: true },
		);
	};

	return {
		showQuiet,
		tellNoModel,
		tellConcluded,
		putOffTurn,
		handedOver,
		say,
		glance,
		unstopped,
		note,
		settled,
		glanceDigest,
		resumed,
		readWhatWaited,
	};
}

/** What createHanding gives the modules after it. */
export type Handing = ReturnType<typeof createHanding>;
