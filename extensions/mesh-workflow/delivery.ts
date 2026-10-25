/**
 * What the model reads of the mesh: messages it notes in full, and
 * glances, one line each.
 */

import {
	clock,
	INTENTS,
	type Intent,
	line,
	type Message,
	shortId,
} from "../../lib/mesh/message.ts";
import type { HoldEnd } from "./leases.ts";

/** The customType of messages delivered in full. */
export const NOTED = "mesh";

/** The customType of a digest of glances delivered on their own. */
export const GLANCES = "mesh-glances";

/** The customType of the screen entry for one glance as it arrives. */
export const GLANCE = "mesh-glance";

/**
 * The most glances one digest spells out. Past it they are counted, so
 * a flood of other peers' news costs a line, not a page; the swarm
 * handed signals over "at most six of a kind".
 */
export const MOST_GLANCES = 6;

/** How long one glance may run, which is one line of a wide terminal. */
export const GLANCE_CHARS = 160;

/**
 * What the model is told after every delivery in full.
 *
 * Said every time rather than once in the prompt, because the note is
 * what the model is looking at. It used to say a message was context,
 * not a task, to keep a model from dropping its work for news; models
 * took that as leave to sit on questions put to them and on what the
 * person had to do, so it now says which messages are to be acted on
 * at once, and that the person hears at once what waits on them.
 */
export const ADVISORY =
	"Act now on a question or a hold put to you, before you carry on, as its line above says. If a message holds something the person must act on (a decision, a login, a look, a yes), tell them at once: in your reply if you are talking with them, and otherwise to your quest's orchestrator as a question. Everything else is context for your work: carry on with it, and send no acknowledgement.";

/** What each intent asks of its reader, said only for those present. */
export const ASKS: Readonly<Record<Intent, string>> = {
	hold: "A hold: do not start what it names until its sender says the hold is over. If it holds up work of yours, or you cannot hold, answer it with mesh_send, re set to its id, saying what: its holder sees what waits on it, and you get a turn to carry on when it ends. Otherwise no reply.",
	question:
		"A question: answer it now, before anything else, with mesh_send to its sender, briefly, re set to the question's id. If you can't answer yet, say so and when you will. Then carry on with what you were doing, or stop there if you were doing nothing.",
	finding:
		"A finding: if you own what it is about, check it against the source before you act on it, then note it in your plan or journal and act on it in its turn; if you do not own it, let it go. No reply.",
	fyi: "An fyi: context only. No reply and no action.",
};

/**
 * What a delivery records, so a reload knows which glances it carried
 * and what the peer's limits had counted (see lib/mesh/damping.ts).
 */
export interface Delivered {
	readonly messages: readonly Message[];
	/** The ids of the glances it carried. */
	readonly glanced: readonly string[];
	/** When it was handed over, in milliseconds. */
	readonly at?: number;
	/** Whether it started a turn, which counts against the peer's hour. */
	readonly turn?: boolean;
	/** Why each message got the attention it did, for the screen. */
	readonly why?: readonly string[];
	/**
	 * The session this peer said it left its quest's address to, so a
	 * reload does not say it again (see address.ts).
	 */
	readonly leftTo?: string;
}

/** Messages in full, with any glances waiting carried along. */
export function noted(
	messages: readonly Message[],
	glances: readonly Message[] = [],
): string {
	const each = messages.map((message) => {
		const threads = [
			message.re ? `answering [${shortId({ id: message.re })}]` : "",
			message.supersedes
				? `replacing [${shortId({ id: message.supersedes })}], which its sender withdraws: go by this one instead`
				: "",
		].filter(Boolean);
		const thread = threads.length > 0 ? `, ${threads.join(", ")}` : "";
		return `Mesh message [${shortId(message)}] (${message.intent}) from ${message.from} to ${message.to.join(", ")} at ${clock(message)}${thread}:\n\n${message.text}`;
	});
	const asks = INTENTS.filter((intent) =>
		messages.some((message) => message.intent === intent),
	).map((intent) => ASKS[intent]);
	return [
		...each,
		asks.join(" "),
		...(glances.length > 0 ? [digest(glances)] : []),
		ADVISORY,
	].join("\n\n");
}

/**
 * Holds this peer waited on that are over, in full, carrying whatever
 * glances wait. Unlike a message, it asks something: carry on, once
 * what the hold named is known to be free. A hold whose holder never
 * said it was over is not permission: it lapsed or lost its holder,
 * and what it named may be running still.
 */
export function holdsOver(
	ends: readonly HoldEnd[],
	glances: readonly Message[] = [],
): string {
	const each = ends.map(
		({ hold, how, why }) =>
			`The hold [${shortId(hold)}] from ${hold.from} at ${clock(hold)} is over: ${how}.${why ? ` This peer had said: "${why}".` : ""}\n\n${hold.text}`,
	);
	const unsaid = ends.filter(({ said }) => !said).map(({ hold }) => hold);
	return [
		...each,
		unsaid.length === 0
			? "Carry on with what it held up, unless something since says otherwise."
			: `Its holder never said ${unsaid.map((hold) => `[${shortId(hold)}]`).join(" or ")} was over, so what it named may still be in use: check that it is free (mesh_read, mesh_groups, or ask where the hold was sent) before carrying on with what it held up.`,
		...(glances.length > 0 ? [digest(glances)] : []),
	].join("\n\n");
}

/**
 * Glances as one digest: a line each, up to the most spelled out, then
 * a count of the rest. Nothing in it asks anything of the reader.
 */
export function digest(glances: readonly Message[]): string {
	const shown = glances.slice(0, MOST_GLANCES).map(glanceLine);
	const rest = glances.length - shown.length;
	return [
		"At a glance, other peers' own work (nothing asked of you; mesh_read has it in full):",
		...shown,
		...(rest > 0 ? [`- and ${rest} more`] : []),
	].join("\n");
}

/** One glance, cut to a line. */
export function glanceLine(message: Message): string {
	const whole = `- ${line(message)}`.replace(/\s+/g, " ");
	return whole.length > GLANCE_CHARS
		? `${whole.slice(0, GLANCE_CHARS - 1)}…`
		: whole;
}
