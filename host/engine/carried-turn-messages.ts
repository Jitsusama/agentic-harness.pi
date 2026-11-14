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
 * own whenever the agent runs and the session counts no run.
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
	"isStreaming" | "subscribe" | "sendCustomMessage"
>;

/** The events after which a held message no longer splits a call from its result. */
const TURN_ENDS = new Set(["turn_end", "agent_end"]);

/**
 * Make the session hold an extension's message through a turn its agent
 * runs while the session counts no run, as pi's session holds one through
 * its own: steered or followed up when it asks for a turn, written once
 * the turn ends when it doesn't; a held one pi fails to write goes to
 * report. Returns what undoes it.
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
	return () => {
		unsubscribe();
		session.sendCustomMessage = send;
	};
}

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
