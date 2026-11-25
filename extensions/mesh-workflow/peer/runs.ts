/**
 * A peer through its session's runs: turns, steps and usage, the person
 * typing, prompts open, and letting go as the session shuts down.
 */

import { hosted } from "../../../lib/core/session/index.ts";
import { closeLanded } from "../../../lib/internal/carry/under-way.ts";
import { contextUsageOf } from "../../../lib/internal/session/context-usage.ts";
import { isPersonText } from "../../../lib/internal/session/driven.ts";
import { runStarted } from "../../../lib/internal/session/first-prompt.ts";
import { isParked } from "../../../lib/internal/session/park.ts";
import { ROLLOVER_CARRY } from "../../../lib/internal/session/rollover.ts";
import { onTurnEnd } from "../../../lib/internal/session/turn-end.ts";
import { RUN_KINDS } from "../../../lib/mesh/lease.ts";
import { toolDetail } from "../../../lib/mesh/step.ts";
import { localDay, noUsage, withCall } from "../../../lib/mesh/usage.ts";
import { NOTED, noted, personsPath } from "../delivery.ts";
import { parkHeavyCalls, parkWaitingCalls, reloading } from "../leases.ts";
import {
	assistantText,
	endsForGood,
	followWithheld,
	userText,
} from "../talks.ts";
import { keptAbove } from "../tools/above.ts";
import { markOwnerRunning, settleFromVerdicts } from "../wait.ts";
import type { Handing } from "./handing.ts";
import type { Hearing } from "./hearing.ts";
import type { HeavyWork } from "./heavy.ts";
import { delivered, type MeshState } from "./mesh.ts";
import { CARRY_NAME } from "./start.ts";

/** What begins a run a host carries on, which pi's runForHost names it. */
const CARRIED_ON = "continue";

/** Follow this peer's session through its runs and its end. */
export function onRuns(m: MeshState, f: Handing & Hearing & HeavyWork) {
	// A glance reaches the model with its next turn: at the end of this
	// step while a run goes on, where pi appends it after the step's
	// tool results, or with the start of the next run while idle. A
	// pause asked for mid-run lands here too, the turn's tools done.
	onTurnEnd(m.pi, async (turn) => {
		m.leasing.stillAnswering();
		const message = f.glanceDigest();
		if (message) m.pi.sendMessage(message, { triggerTurn: false });
		m.pausing.turnEnded();
		m.ordering.turnEnded();
		// Only a turn whose tools ran goes on to ask the model again; one
		// handed on at the run's end finished it, and isn't cut off.
		if (turn.toolResults.length > 0 && turn.outcome === "completed")
			m.moving.turnEnded();
	});
	// A run started by something else takes what was waiting to act
	// with it, in full, and the turn it waited for is never started. A
	// run a host carries on after a restart takes nothing: pi holds its
	// message for the prompt after it, so what waits acts as it ends.
	m.pi.on("before_agent_start", async (event) => {
		const trigger: string = event.messageType;
		if (trigger === CARRIED_ON) return undefined;
		const waiting = f.unstopped(m.acts?.take() ?? []);
		if (waiting.length === 0) {
			const message = f.glanceDigest();
			return message ? { message } : undefined;
		}
		const messages = waiting.map(({ message }) => message);
		m.leasing.answering(messages);
		const carried = m.glances.take();
		f.handedOver(messages);
		m.damper.handed(messages);
		return {
			message: {
				customType: NOTED,
				content: noted(
					messages,
					carried,
					keptAbove(m.peer?.orchestratedBy, m.hub),
					personsPath(m.peer),
				),
				display: true,
				details: delivered(messages, carried, {
					why: waiting.map(({ heed }) => heed.why),
				}),
			},
		};
	});

	// A reply another extension withheld once finished, which a talk may
	// have had first: the talk is replied by what stands in its place.
	followWithheld(m.pi.events, m.talks);

	// A log about to roll over names the session the fresh one carries
	// on from, so it can take this peer's presence and leases.
	m.pi.events?.on(ROLLOVER_CARRY, (data: unknown) => {
		const carry = data as { carried?: unknown } | undefined;
		if (!m.peer || typeof carry?.carried !== "object" || !carry.carried) {
			return;
		}
		(carry.carried as Record<string, unknown>)[CARRY_NAME] = {
			session: m.peer.session,
		};
	});

	// The person typing in the window is at the desk: a pause ends, and
	// what they typed is the run, never ended as it starts.
	m.pi.on("input", async (event) => {
		// As the log is read at start: a launcher talk or an RPC client's
		// prompt is a person's too.
		if (isPersonText(event.text)) m.peer?.setDriven();
		if (event.source === "interactive") {
			m.pausing.talked();
			m.moving.typed();
		}
		return { action: "continue" };
	});
	// Whether a peer is mid-run is part of what others see of it.
	m.pi.on("agent_start", async () => {
		runStarted();
		m.peer?.setBusy(true);
		// Whatever woke a paused session, it sleeps on.
		m.pausing.started();
		m.moving.started();
		m.ordering.started();
	});
	// And the step it is on, by the tool it runs, for the desktop's Busy;
	// a talk the person follows hears the step, its reply as it is
	// written, and the reply once the run settles.
	m.pi.on("tool_execution_start", async (event) => {
		m.peer?.setStep(event.toolName, toolDetail(event.args));
		m.talks.step(event.toolName);
	});
	// Each model call: thinking until it answers, and timed for usage.
	m.pi.on("turn_start", async () => {
		m.call = { startedAt: Date.now() };
		m.peer?.setThinking();
	});
	m.pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && m.call && !m.call.firstTokenAt) {
			m.call = { ...m.call, firstTokenAt: Date.now() };
		}
		m.talks.writing(assistantText(event.message));
	});
	m.pi.on("message_end", async (event, ctx) => {
		if (m.peer && event.message.role === "assistant") {
			const context = contextUsageOf(ctx);
			m.peer.setUsage(
				withCall(m.peer.usage ?? noUsage(localDay(new Date())), event.message, {
					at: new Date(),
					...m.call,
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
			m.call = undefined;
		}
		// The steer's own message, once in the conversation, is what
		// takes its talk into the run that answers it.
		m.talks.heard(userText(event.message));
		m.talks.wrote(assistantText(event.message));
	});
	m.pi.on("agent_settled", async (event) => {
		m.talks.settled(event.aborted);
		// pi reads idle from here; a Park asked for mid-run parks it once
		// this settle has been said, never from within it.
		setImmediate(() => {
			try {
				m.pausing.settled();
			} catch {
				// Out of a bare setImmediate it would end the process. A
				// session replaced since its run settled is no longer this one's
				// to park; a refusal says itself in its journal whatever its
				// screen meets.
			}
		});
	});
	m.pi.on("agent_end", async () => {
		f.lookAgain();
		void m.tidy();
		m.peer?.setBusy(false);
		// What the desktop's daemon found done or ready since (wait.ts).
		if (m.waiting) settleFromVerdicts(m.waiting);
		// What a run claimed is claimed only while it runs.
		m.own?.releaseAll(RUN_KINDS);
		// A move waiting may find the session free now.
		m.moving.look();
	});
	// A prompt open for the person holds a move until it closes.
	m.pi.on("ui_prompt_start", async () => {
		m.prompts += 1;
	});
	m.pi.on("ui_prompt_end", async () => {
		m.prompts = Math.max(0, m.prompts - 1);
		m.moving.look();
	});

	m.pi.on("session_shutdown", async (event) => {
		// Its close has landed, so a carry that carried lets the session go:
		// a host's process outlives the conversation and may open it again.
		// A reload keeps the conversation, so its close is still to come.
		if (m.peer && !reloading(event)) closeLanded(m.peer.session);
		m.moving.stop();
		m.unhearKeys?.();
		m.unhearKeys = undefined;
		// What still waits is not marked read, so the next start has it.
		m.acts?.stop();
		clearInterval(m.lookClock);
		m.lookClock = undefined;
		m.hub?.stop();
		m.hub = undefined;
		// Endings still untold were this session's: a session started next in
		// the same process would sign them as its own, so they end with it,
		// as a reload ends them.
		m.endingsUntold = [];
		clearInterval(m.looksClock);
		m.looksClock = undefined;
		// A session parking is still there to wake, so only one ending for
		// good says its items' owner has ended.
		if (m.waiting && !(m.peer && isParked(m.peer.session))) {
			markOwnerRunning(m.waiting, false);
		}
		// Ending for good moves on from its replies; a reload, a park, a
		// restart in place or a rollover carries on with them (85PKB2).
		if (
			m.peer &&
			endsForGood(event, {
				parked: isParked(m.peer.session),
				restarting: m.restartAsked?.restarting === true,
			})
		) {
			m.talks.ended();
		}
		m.resumes?.stop();
		clearInterval(m.waitClock);
		m.waitClock = undefined;
		clearInterval(m.settleClock);
		m.settleClock = undefined;
		if (reloading(event)) {
			// Its heavy work runs on through a reload, as its jobs do, so its
			// leases stay and the runtime the reload starts releases them.
			m.own?.releaseAll(RUN_KINDS);
			parkHeavyCalls(f.heavyCalls.held());
			parkWaitingCalls(m.waitingCalls);
		} else {
			// Any other end stops the session's jobs, and its heavy work with them.
			m.own?.releaseAll(new Set([...RUN_KINDS, "heavy" as const]));
			m.unowned.length = 0;
		}
		m.takenUnowned.length = 0;
		f.heavyCalls.clear();
		m.stopWatching?.();
		m.stopWatching = undefined;
		m.untellAwaited?.();
		m.untellAwaited = undefined;
		m.unhearPresent?.();
		m.unhearPresent = undefined;
		m.steering?.stop();
		m.steering = undefined;
		// A plain pi's presence stays a day after it ends, so it says it
		// ended rather than read as a crash: on 15 November health counted
		// 24 sessions put down on purpose as agents that died (80ECO2).
		// A reload carries on, a parked peer stays parked, and a hosted
		// conversation's presence goes below.
		if (m.peer && !hosted() && !reloading(event)) {
			m.peer.end();
		}
		// The peer goes with its session. Work still in flight from it, a
		// count of who is live or a message being judged, finds no peer
		// and stops: on 29 October one such refresh read the session's
		// context after a rollover had switched it out, and pi took the
		// throw as an uncaught exception 146 ms into the switch, after
		// which the session heard nothing more (and on 22 October, a
		// reload's landing note did the same).
		m.peer?.dispose();
		// A hosted conversation's presence goes with it, unless it parked: its
		// host is still there to wake it, and a sender finds it parked by its
		// presence (wakeParked), as it finds a plain pi that parked.
		if (hosted() && m.peer && !reloading(event) && !isParked(m.peer.session))
			m.presences.forget(m.peer.session);
		// What a host still had on its way lands before the session goes:
		// its presence marked ended and its leases released (85PKB2).
		m.presences.settle();
		m.board.settle();
		// Last, so the ended presence above goes to the node before the link
		// hangs up; the next load, a reload's or another session's, opens its own.
		m.workerLink?.close();
		m.peer = undefined;
		m.hideWants?.();
		m.hideWants = undefined;
	});
}
