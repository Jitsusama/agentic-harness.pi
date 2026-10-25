/**
 * Steering: the inboxes of this peer's addresses watched, and what
 * the person writes to one handed to the session as their own message
 * (lib/mesh/steer.ts says why it is not a mesh message).
 *
 * A peer's addresses change as it works: a quest's address comes and
 * goes with the quest. So the inboxes watched are settled again each
 * time the peer looks, and every look takes what is waiting in all of
 * them, which also catches what a watcher never reported.
 */

import { type FSWatcher, watch } from "node:fs";
import { inboxOf, type Steer, takeSteers } from "../../lib/mesh/steer.ts";

/** What steering needs from the session it delivers to. */
export interface SteeringHost {
	/** The steer folders' root, one folder per address below it. */
	readonly root: string;
	/** The addresses this peer goes by now. */
	readonly addresses: () => readonly string[];
	/** Says to the session what the person wrote. */
	readonly deliver: (steer: Steer) => void;
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
		for (const steer of taken.steers) host.deliver(steer);
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

/** What the session reads: the person's words, saying where they came from. */
export function steerText(steer: Steer): string {
	const who = steer.from ?? "the person";
	return `[Steered by ${who} from outside this window, so a reply here may go unread until they come to it.]\n\n${steer.text}`;
}
