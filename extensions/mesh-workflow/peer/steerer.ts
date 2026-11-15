/**
 * The person's words and acts from outside the window, through the steer
 * inboxes: a talk, an answer, a pause, a move or a carry.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionKeyOf } from "../../../lib/core/session/index.ts";
import { PERSON_TALKED } from "../../../lib/internal/priority/typed.ts";
import { isMoveTarget } from "../../../lib/internal/session/move.ts";
import { loadedQuest } from "../../../lib/mesh/address.ts";
import { isPersonsTalk, type Steer } from "../../../lib/mesh/steer.ts";
import {
	answerLookSteered,
	answerSteered,
	createSteering,
	LOOK_GONE,
	steerDelivery,
	steerText,
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
	 * The person's words from outside the window, as their own message:
	 * a turn when idle, otherwise once the run under way ends, or into it
	 * after its tool when the steer says now (steerDelivery).
	 */
	const steered = (
		text: string,
		idle: boolean,
		steer: Pick<Steer, "now"> = {},
	) => {
		const deliverAs = steerDelivery(steer, idle);
		m.pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
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
				// Never the person's carry: the node vouches for who ordered it.
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
					m.pausing.act(one.act, one.from);
					return;
				}
				m.pausing.talked();
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
		});
		setTimeout(() => m.steering?.look(), FIRST_STEER_MS).unref?.();
	};

	return { steered, answerFromAway, steer };
}

/** What createSteerer gives the modules after it. */
export type Steerer = ReturnType<typeof createSteerer>;
