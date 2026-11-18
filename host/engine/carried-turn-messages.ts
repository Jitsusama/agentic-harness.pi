/**
 * An extension's message sent during a turn the host carries on after a
 * restart, kept out of the middle of its tool round. pi's session holds
 * such a message back while it counts a run of its own, steering it in or
 * writing it once the turn ends, since one written between a tool call
 * and its result is refused by providers that check the order. A turn
 * durable carries on is no run of pi's session, so pi wrote the message
 * at once: on 13 November a mesh message landed between a call and its
 * result in two conversations, and every later request was refused.
 * Here the session's sendCustomMessage does what pi does in a run of its
 * own whenever the agent runs and the session counts no run. A host stops
 * in the middle of such turns, so what is held is written as the session
 * is disposed, even mid-round: a peer's lost words cost more than their
 * place, which the request's pairing mends (paired-results.ts). Where pi
 * has the seam, a carried turn is pi's own run, so pi holds the message
 * and drops it as it lets go; pi's own flush writes it first.
 */

import type {
	AgentSession,
	CustomMessageInput,
	CustomMessageOptions,
} from "./pi-session.ts";
import type { AgentMessage } from "./pi-types.ts";

/** The agent, as far as holding a message through its turn needs it. */
export interface CarryingAgent {
	readonly state: { readonly isStreaming: boolean };
	steer(message: AgentMessage): void;
	followUp(message: AgentMessage): void;
}

/** The session, as far as holding a message through a carried-on turn needs it. */
export type MessagingSession = Pick<
	AgentSession,
	"isStreaming" | "subscribe" | "sendCustomMessage" | "dispose"
>;

/** The events after which a held message no longer splits a call from its result. */
const TURN_ENDS = new Set(["turn_end", "agent_end"]);

/**
 * Make the session hold an extension's message through a turn its agent
 * runs while the session counts no run, as pi's session holds one through
 * its own: steered or followed up when it asks for a turn, written once
 * the turn ends when it doesn't, or as the session is disposed; a held
 * one pi fails to write goes to report. The hold ends with the session's
 * dispose; what it returns ends it sooner.
 */
export function holdMessagesThroughCarriedTurns(
	session: MessagingSession,
	agent: CarryingAgent,
	report: (error: unknown) => void,
): () => void {
	const send = session.sendCustomMessage.bind(session);
	let held: Array<{
		message: CustomMessageInput;
		options: CustomMessageOptions | undefined;
	}> = [];
	const carrying = () => agent.state.isStreaming && !session.isStreaming;
	// Each is written as it is sent, in order, while the turn's results are the last of the file.
	const flush = () => {
		const due = held;
		held = [];
		for (const { message, options } of due)
			send(message, options).catch(report);
	};
	const unsubscribe = session.subscribe((event) => {
		if (TURN_ENDS.has(event.type) && held.length > 0) flush();
	});
	const dispose = session.dispose.bind(session);
	const undo = () => {
		unsubscribe();
		session.sendCustomMessage = send;
		session.dispose = dispose;
	};
	session.dispose = () => {
		undo();
		writeWhatPiHolds(session, report);
		// pi writes a no-turn message at once while it counts no run, so it is in the file before pi lets go of it.
		flush();
		dispose();
	};
	session.sendCustomMessage = async (message, options) => {
		if (!carrying() || options?.deliverAs === "nextTurn")
			return await send(message, options);
		if (options?.triggerTurn !== false) {
			const queued = asAgentMessage(message);
			if (options?.deliverAs === "followUp") agent.followUp(queued);
			else agent.steer(queued);
			return;
		}
		held.push({ message, options });
	};
	return undo;
}

/**
 * Write what pi holds through a run it counts, as it would once the turn
 * ends. pi keeps that flush to itself, so it is found by name; a pi that
 * moves it drops the message, as pi does, and that loss is reported.
 */
function writeWhatPiHolds(
	session: MessagingSession,
	report: (error: unknown) => void,
): void {
	if (!session.isStreaming) return;
	const flush: unknown = Reflect.get(session, PI_FLUSH);
	if (typeof flush !== "function") {
		report(
			new Error(
				`pi has no ${PI_FLUSH}, so what it held through its run is lost as it lets go`,
			),
		);
		return;
	}
	try {
		flush.call(session);
	} catch (error) {
		// The session still lets go: a word pi fails to write is reported, as one held here is.
		report(error);
	}
}

/** pi's own name for writing the messages it held through a turn. */
const PI_FLUSH = "_flushPendingCustomMessages";

/** The message as pi's session hands it to its agent. */
function asAgentMessage(message: CustomMessageInput): AgentMessage {
	return {
		role: "custom",
		customType: message.customType,
		// An untyped extension can pass no content; pi normalizes it the same way.
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		timestamp: Date.now(),
	};
}
