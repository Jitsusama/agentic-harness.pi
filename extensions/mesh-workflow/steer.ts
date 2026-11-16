/**
 * Steering: the inboxes of this peer's addresses watched, and what
 * the person writes to one handed to the session as their own message
 * (lib/mesh/steer.ts says why it is not a mesh message).
 *
 * A peer's addresses change as it works: a quest's address comes and
 * goes with the quest. So the inboxes watched are settled again each
 * time the peer looks, and every look takes what is waiting in all of
 * them, which also catches what a watcher never reported.
 *
 * An answer the person gives an open ask from the launcher goes to the
 * ask itself, not the conversation, so it is taken as if picked there.
 */

import { type FSWatcher, watch } from "node:fs";
import { withSession } from "../../lib/core/session/index.ts";
import { answerWant } from "../../lib/internal/session/wants.ts";
import { coalescing } from "../../lib/internal/single-flight.ts";
import { answerLook, type Look, looksIn } from "../../lib/mesh/looks.ts";
import {
	FROM_MACHINE,
	FROM_PERSON,
	inboxOf,
	type Steer,
	type Taken,
	takenSteers,
} from "../../lib/mesh/steer.ts";

/** What steering needs from the session it delivers to. */
export interface SteeringHost {
	/** The steer folders' root, one folder per address below it. */
	readonly root: string;
	/** The addresses this peer goes by now. */
	readonly addresses: () => readonly string[];
	/** Says to the session what the person wrote, and in which inbox. */
	readonly deliver: (steer: Steer, inbox: string) => void;
	/** Says on screen that a file was set aside, and which. */
	readonly setAside: (inbox: string, names: readonly string[]) => void;
}

/** Steering for one session, until it is stopped. */
export interface Steering {
	/** Settles the inboxes watched, and takes what waits in each. */
	look(): Promise<void>;
	stop(): void;
}

/**
 * Starts steering: nothing is watched or taken until the first look.
 *
 * Each inbox is read off the thread, since a host runs every
 * conversation's look on one thread and a stalled disk would hold them
 * all. An inbox's takes never run beside each other, so steers arrive
 * in the order they were written: an ask while one reads runs once more
 * after it, rather than being passed over, so what arrived meanwhile
 * is read at once rather than at the next look.
 */
export function createSteering(host: SteeringHost): Steering {
	const watching = new Map<string, FSWatcher>();
	const starting = new Set<string>();
	const takers = new Map<string, () => Promise<void>>();
	const taker = `${process.pid}`;
	let stopped = false;

	const take = (inbox: string): Promise<void> => {
		let takes = takers.get(inbox);
		if (takes === undefined) {
			takes = coalescing(async () => {
				// Stopped, none starts; one already reading claims nothing.
				if (stopped) return;
				let taken: Taken;
				try {
					taken = await takenSteers(inbox, taker, undefined, () => !stopped);
				} catch {
					// An inbox that cannot be read now is read at the next look.
					return;
				}
				for (const steer of taken.steers) host.deliver(steer, inbox);
				if (taken.bad.length > 0) host.setAside(inbox, taken.bad);
			});
			takers.set(inbox, takes);
		}
		return takes();
	};

	const watchFrom = async (inbox: string): Promise<void> => {
		starting.add(inbox);
		try {
			// Taking first makes the folder a watcher needs.
			await take(inbox);
			if (stopped) return;
			const watcher = watch(inbox, (_kind, name) => {
				if (name?.endsWith(".json")) void take(inbox).catch(lookAgain);
			});
			watcher.unref?.();
			watching.set(inbox, watcher);
		} catch {
			// Left unwatched, it is still taken at every look.
		} finally {
			starting.delete(inbox);
		}
	};

	const settle = async (): Promise<Set<string>> => {
		const now = new Set(
			host.addresses().map((address) => inboxOf(host.root, address)),
		);
		for (const [inbox, watcher] of watching) {
			if (now.has(inbox)) continue;
			watcher.close();
			watching.delete(inbox);
		}
		await Promise.all(
			[...now]
				.filter((inbox) => !watching.has(inbox) && !starting.has(inbox))
				.map(watchFrom),
		);
		return now;
	};

	return {
		async look() {
			await Promise.all([...(await settle())].map(take));
		},
		stop() {
			stopped = true;
			for (const watcher of watching.values()) watcher.close();
			watching.clear();
		},
	};
}

/**
 * How a steer's words reach the session: a turn of their own when it is
 * idle (nothing), read into the run under way after its current tool
 * when the steer says `now`, and otherwise once that run ends, so a
 * task isn't broken into unless the person says to.
 */
export function steerDelivery(
	steer: Pick<Steer, "now">,
	idle: boolean,
): "steer" | "followUp" | undefined {
	if (idle) return undefined;
	return steer.now ? "steer" : "followUp";
}

/** What the session is doing as a steer reaches it. */
export interface SteeredInto {
	/** Whether a run is under way, which the steer is read into. */
	readonly busy: boolean;
}

/**
 * What the session reads: the person asking, to be answered first and
 * briefly, or the machine's words, saying they aren't the person's.
 *
 * The person's words are a question put from the launcher or another
 * window, where the talk shows the first answer; framed as mere
 * context, a busy session read them as a note and never answered.
 */
export function steerText(steer: Steer, into: SteeredInto): string {
	if (steer.from === FROM_MACHINE) {
		const who = steer.by ?? "mycelium node";
		return `[Said by this machine's ${who}, not by the person, through this session's steer inbox.]\n\n${steer.text}`;
	}
	const then = into.busy
		? " while this session works: answer first, in a line or two, then carry on."
		: ": answer first, in a line or two, then do what is asked.";
	return `[${asker(steer.from)} is asking from outside this window${then}]\n\n${steer.text}`;
}

/** What the window says of an answer that came for an ask now gone. */
export const ANSWER_GONE =
	"An answer from outside this window came for a question it no longer asks, so nothing was answered.";

/**
 * Give an `answer` steer to the open ask its want names, in `session`,
 * since a watcher's callback may run outside the session it serves.
 * When the ask has moved on, `tell` says so on screen.
 */
export function answerSteered(
	steer: Steer,
	session: string | undefined,
	tell: (text: string) => void,
): void {
	const { want, given } = steer;
	const taken =
		want !== undefined &&
		given !== undefined &&
		withSession(session, () => answerWant(want, given));
	if (!taken) tell(ANSWER_GONE);
}

/** What the window says of an answer that came for a look now gone. */
export const LOOK_GONE =
	"An answer from outside this window came for something on the person's look list that no longer waits, so nothing was answered.";

/** The session a look's answer reaches, and its quest. */
export interface Answering {
	readonly session: string;
	readonly quest?: string;
}

/**
 * Give an `answer` steer to the look it names, kept in `looks`: the look
 * resolves with what the person picked, and `say` hands it to the agent.
 * A look of this session's, or of its quest's, since a session gone is
 * answered by the one on its quest now. When the look no longer waits
 * or isn't this session's to answer, `tell` says so on screen.
 */
export function answerLookSteered(
	steer: Steer,
	looks: string,
	answering: Answering,
	say: (text: string) => void,
	tell: (text: string) => void,
): void {
	const { look: id, given } = steer;
	const look = looksIn(looks).find((one) => one.id === id);
	const ours =
		look !== undefined &&
		(look.session === answering.session ||
			(look.quest !== undefined && look.quest === answering.quest));
	const answered =
		ours && given !== undefined && "value" in given
			? answerLook(looks, look.id, given.value)
			: undefined;
	if (!answered) {
		tell(LOOK_GONE);
		return;
	}
	say(lookAnswerText(answered, steer.from));
}

/** What the agent reads of the person's answer to a look. */
export function lookAnswerText(look: Look, from?: string): string {
	const label =
		look.choices?.find((one) => one.value === look.answer)?.label ??
		look.answer;
	const asked = look.ask ? ` It asked: ${look.ask}` : "";
	return `[${asker(from)} answered from outside this window what this session put on their look list, "${look.title}".${asked} They picked: ${label}. Act on it, and take nothing back: the look is already off their list.]`;
}

/** Nothing, for a take whose delivery threw: the next look takes again. */
export function lookAgain(): void {
	// A session gone as its steer arrived; what still waits is taken later.
}

/** Who a steer's writer reads as: Joel by name, else the person. */
function asker(from: string | undefined): string {
	if (!from || from === FROM_PERSON) return "The person";
	return `${from.charAt(0).toUpperCase()}${from.slice(1)}`;
}
