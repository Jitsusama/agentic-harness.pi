/**
 * The person's words and acts from outside the window, through the steer
 * inboxes: a talk, an answer, a pause, a move or a carry.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionKeyOf } from "../../../lib/core/session/index.ts";
import { PERSON_TALKED } from "../../../lib/internal/priority/typed.ts";
import { userTextOf } from "../../../lib/internal/session/driven.ts";
import { isMoveTarget } from "../../../lib/internal/session/move.ts";
import { answerSteerWaiting, saySteered } from "../../../lib/jobs/steer.ts";
import { loadedQuest } from "../../../lib/mesh/address.ts";
import { isPersonsTalk, type Steer } from "../../../lib/mesh/steer.ts";
import {
	answerLookSteered,
	answerSteered,
	createSteering,
	LOOK_GONE,
	steerDelivery,
	steerText,
	takenAtNextLook,
} from "../steer.ts";
import type { MeshState } from "./mesh.ts";

/**
 * How long after a session starts it first takes its steer inboxes.
 * Pi refuses a second turn beside the first prompt, so what waited
 * through a restart is taken once that prompt is under way, as a steer
 * into its run, or as a turn of its own when there was none.
 */
const FIRST_STEER_MS = 3000;

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

/** Steering for this peer, from the person's inboxes. */
export function createSteerer(m: MeshState) {
	/**
	 * The talk steered into the run under way that pi has yet to read,
	 * each from its steer until pi reads those very words as a user's
	 * message, or the run settles, as job-workflow holds a typed line. So a
	 * call that starts after it moves to the background too, and none once
	 * the last is read. pi reads one steer a turn, so another's message
	 * read first, a typed line or a peer's, leaves the talk waiting.
	 */
	const unread: string[] = [];
	let answering: (() => void) | undefined;
	/** Stop answering, so a reload's next steerer answers alone. */
	const stopAnswering = () => {
		answering?.();
		answering = undefined;
		unread.length = 0;
	};
	/** pi read `text`, so it no longer waits, if it was talk that did. */
	const read = (text: string | undefined) => {
		const at = text === undefined ? -1 : unread.indexOf(text);
		if (at >= 0) unread.splice(at, 1);
	};
	m.pi.on("session_start", () => {
		stopAnswering();
		answering = answerSteerWaiting(m.pi.events, () => unread.length > 0);
	});
	m.pi.on("session_shutdown", stopAnswering);
	m.pi.on("message_start", (event) => {
		read(userTextOf({ type: "message", message: event.message }));
	});
	m.pi.on("agent_settled", () => {
		unread.length = 0;
	});

	/**
	 * The person's words from outside the window, as their own message:
	 * a turn when idle, otherwise as steerDelivery says for a steer: into
	 * the run under way for the person's talk, else once that run ends. A
	 * look's answer comes with no steer, and waits for the run to end.
	 * Talk read into the run is said as a typed line is, and waits as one
	 * does until pi reads it or the run settles, so a call that can move to the
	 * background moves rather than hold it, running or started since
	 * (lib/jobs).
	 */
	const steered = (
		text: string,
		idle: boolean,
		steer?: Pick<Steer, "now" | "text" | "act" | "from">,
	) => {
		const afterRun = idle ? undefined : "followUp";
		const deliverAs = steer ? steerDelivery(steer, idle) : afterRun;
		if (deliverAs !== "steer") {
			m.pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
			return;
		}
		// Marked before it is sent, so pi's reading it, however soon, clears
		// it, and let go if it never was.
		unread.push(text);
		try {
			m.pi.sendUserMessage(text, { deliverAs });
		} catch (error) {
			read(text);
			throw error;
		}
		saySteered(m.pi.events);
	};

	/**
	 * An answer the person gave from the launcher: an open ask takes it
	 * as typed, a look resolves and its answer goes to the agent, or,
	 * when either has moved on, the window says so.
	 */
	const answerFromAway = (one: Steer) => {
		const at = m.ctx;
		if (!at) return;
		const tell = (text: string) => {
			if (at.hasUI) at.ui.notify(text, "info");
		};
		if (one.look === undefined) {
			answerSteered(one, sessionKeyOf(at), tell);
			return;
		}
		if (!(m.paths.looks && m.peer)) {
			tell(LOOK_GONE);
			return;
		}
		const quest = loadedQuest(m.peer.session, m.paths.sessions);
		answerLookSteered(
			one,
			m.paths.looks,
			{ session: m.peer.session, ...(quest ? { quest } : {}) },
			(text) => steered(text, at.isIdle?.() ?? true),
			tell,
		);
	};

	/** Steering for this session's addresses, when the mesh has inboxes. */
	const steer = (root: string | undefined) => {
		m.steering?.stop();
		m.steering = undefined;
		m.steerRoot = root;
		if (root === undefined) return;
		m.steering = createSteering({
			root,
			addresses: () => m.peer?.addresses ?? [],
			deliver: (one, inbox) => {
				// Never the person's carry: `by` names whom the steer claims
				// carries it, an orchestrator or this machine's node, not proof
				// of who wrote it (lib/mesh/steer.ts).
				if (one.ordered) {
					void m.ordering.order(one.ordered);
					return;
				}
				if (one.act === "carry") {
					if (one.to !== undefined) void m.pausing.carry(one.to, one.from);
					return;
				}
				if (one.act === "fill") {
					fillPrompt(m.ctx, one.text);
					return;
				}
				if (one.act === "move") {
					if (isMoveTarget(one.to)) m.moving.move(one.to);
					return;
				}
				if (one.act === "answer") {
					answerFromAway(one);
					return;
				}
				// A resume, a talk or typing says the person is at the desk.
				if (one.act === "resume" || !one.act) m.moving.cancel();
				// Resume with words is a talk; any other act is only the act.
				if (one.act && !(one.act === "resume" && one.text)) {
					// Its time, so a Stop written before the run it would end is dropped.
					m.pausing.act(one.act, one.from, one.at);
					return;
				}
				// Its time, so a Pause written after it isn't taken as ended by it.
				m.pausing.talked(one.at);
				const idle = m.ctx?.isIdle?.() ?? true;
				// Words that wait for the run to end are read as it ends, idle.
				const said = steerText(one, {
					busy: steerDelivery(one, idle) === "steer",
				});
				m.talks.opened(one, inbox, said);
				// The turn it starts, or the run it goes into, is one the person
				// waits on, as on one typed.
				if (isPersonsTalk(one)) {
					m.pi.events.emit(PERSON_TALKED, { intoRun: !idle });
				}
				steered(said, idle, one);
			},
			setAside: (inbox, names) => {
				if (!m.ctx?.hasUI) return;
				m.ctx.ui.notify(
					`Talk: set aside ${names.join(", ")} in ${inbox}, which held no text to deliver.`,
					"warning",
				);
			},
			undelivered: (one, inbox) => {
				if (!m.ctx?.hasUI) return;
				m.ctx.ui.notify(
					`Talk: ${one.file} in ${inbox} was taken but could not be delivered, so it is gone: send it again.`,
					"warning",
				);
			},
		});
		setTimeout(
			() => void m.steering?.look().catch(takenAtNextLook),
			FIRST_STEER_MS,
		).unref?.();
	};

	return { steered, answerFromAway, steer };
}

/** What createSteerer gives the modules after it. */
export type Steerer = ReturnType<typeof createSteerer>;
