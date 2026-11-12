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
import {
	FROM_MACHINE,
	FROM_PERSON,
	inboxOf,
	type Steer,
	takeSteers,
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
	look(): void;
	stop(): void;
}

/** Starts steering: nothing is watched or taken until the first look. */
export function createSteering(host: SteeringHost): Steering {
	const watching = new Map<string, FSWatcher>();
	const taker = `${process.pid}`;

	const take = (inbox: string) => {
		let taken: ReturnType<typeof takeSteers>;
		try {
			taken = takeSteers(inbox, taker);
		} catch {
			// An inbox that cannot be read now is read at the next look.
			return;
		}
		for (const steer of taken.steers) host.deliver(steer, inbox);
		if (taken.bad.length > 0) host.setAside(inbox, taken.bad);
	};

	const settle = () => {
		const now = new Set(
			host.addresses().map((address) => inboxOf(host.root, address)),
		);
		for (const [inbox, watcher] of watching) {
			if (now.has(inbox)) continue;
			watcher.close();
			watching.delete(inbox);
		}
		for (const inbox of now) {
			if (watching.has(inbox)) continue;
			// Taking first makes the folder a watcher needs.
			take(inbox);
			try {
				const watcher = watch(inbox, (_kind, name) => {
					if (name?.endsWith(".json")) take(inbox);
				});
				watcher.unref?.();
				watching.set(inbox, watcher);
			} catch {
				// Left unwatched, it is still taken at every look.
			}
		}
		return now;
	};

	return {
		look() {
			for (const inbox of settle()) take(inbox);
		},
		stop() {
			for (const watcher of watching.values()) watcher.close();
			watching.clear();
		},
	};
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

/** Who a steer's writer reads as: Joel by name, else the person. */
function asker(from: string | undefined): string {
	if (!from || from === FROM_PERSON) return "The person";
	return `${from.charAt(0).toUpperCase()}${from.slice(1)}`;
}
