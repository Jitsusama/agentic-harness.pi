/**
 * Parked peers: sessions that ended idle to hold no memory, and are
 * started again by their holder when something needs them (see
 * internal/session/park.ts).
 *
 * A parked peer's process is gone, but its presence says `parked` while
 * its marker stands, and it is taken as there: what is sent to it rests
 * on disk until it starts again, as for any peer between runs. A sender
 * wakes it for a message that would give it a turn were it there and
 * idle: a question or hold sent to it, an answer to it, a pivot, and
 * for an orchestrator a finding or news sent to it by a session it
 * leads. Judged as attention.ts judges for a receiver, without a
 * classifier, so a message noted or glanced at waits for its next start.
 *
 * A steer is read as the peer starts. A talk wakes it, since a running
 * peer would answer at once and the person is waiting: a parked void
 * left Joel's lines in its inbox until something else started it (12
 * Nov 2026). One that closes it or carries its work to another machine
 * can only be done by the peer running, and whoever asked is waiting on
 * it: mycelium waits for a carried session's done file before it
 * carries the rest. So a peer that looks about it wakes a parked peer
 * whose inbox holds either, through the same holder. A pause or stop
 * does nothing to a peer that isn't running, so it waits. Whoever holds
 * the parked peer also watches its inboxes (watchWakingSteers) and wakes
 * it as such a steer lands, the look being the backstop: Super+S, the
 * launcher's Talk, the void and a steer the node brings from another
 * machine each waited up to 60 s for that look on 14 Nov 2026. A holder
 * outside this package, as mycelium's, is told the inboxes and the rule
 * as the peer parks ({@link holderSteers}), and judges by that rule
 * rather than a copy of its own.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import type { HolderSteers, WakingSteers } from "../internal/session/park.ts";
import { attend } from "./attention.ts";
import { asksEach, type Message, reaches } from "./message.ts";
import type { Presence } from "./presence.ts";
import { inboxOf, ORDERED_CARRY, type Steer, waitingSteers } from "./steer.ts";
import { answers, answersQuestion, type Reader } from "./thread.ts";

/** Whether a presence says its session is parked. */
export function saysParked(presence: Pick<Presence, "state">): boolean {
	return presence.state === "parked";
}

/**
 * Whether this message would give the parked peer a turn, were it
 * there. A pivot counts from anyone: who orchestrates it is read from
 * its quest, which a sender can't see, and waking one for a pivot that
 * proves not its orchestrator's costs one start.
 */
export function wakes(
	message: Message,
	parked: Presence,
	read: Reader,
	sender?: Pick<Presence, "orchestratedBy">,
): boolean {
	const listener = {
		addresses: parked.addresses,
		groups: parked.groups,
		...(parked.machine !== undefined ? { machine: parked.machine } : {}),
	};
	// Its process is gone, so no pid of a sender is its own.
	if (!reaches(message, listener, -1)) return false;
	if (message.intent === "pivot") return true;
	const self = { addresses: parked.addresses, pid: -1 };
	const led =
		sender?.orchestratedBy !== undefined &&
		parked.addresses.includes(sender.orchestratedBy);
	const heed = attend(message, {
		receiver: {
			addresses: parked.addresses,
			worksOn: parked.worksOn,
			owns: parked.owns,
		},
		idle: true,
		...(led ? { led: true } : {}),
		answers: answers(message, read, self),
		asked: answersQuestion(message, read, self),
		askedEach: asksEach(message, listener),
		now: Date.parse(message.at),
	});
	// What it leads acts on once the mesh settles: a turn all the same.
	return heed.attention === "turn" || (led && heed.attention === "act");
}

/**
 * Whether a steer waits on its parked peer running: a talk, or a resume
 * with words, which a running peer answers; a close, a carry or a move,
 * which only a running session can make, and so an orchestrator's
 * ordered carry; a fill, since the person is
 * coming to its window to send it; or the person's answer to a look or a
 * question, which only a running pi takes (an answer the mesh keeps
 * always says what it answers and what it gives).
 */
export function steerWakes(steer: Steer): boolean {
	if (steer.ordered) return WAKING_STEERS.acts.includes(ORDERED_CARRY);
	if (steer.act === undefined) return WAKING_STEERS.talk;
	if (steer.act === "resume" && steer.text !== "") {
		return WAKING_STEERS.resumeWithWords;
	}
	return WAKING_STEERS.acts.includes(steer.act);
}

/**
 * {@link steerWakes} as data, for a holder in another language. Such a
 * holder judges the raw file, so a malformed answer the mesh would drop
 * still wakes its peer, which finds nothing to take and parks again.
 */
export const WAKING_STEERS: WakingSteers = {
	acts: ["close", "carry", ORDERED_CARRY, "move", "fill", "answer"],
	talk: true,
	resumeWithWords: true,
};

/**
 * What a holder outside this package is told of a parking peer's steers:
 * the inbox under `root` of each of its addresses, and which wake it.
 */
export function holderSteers(
	root: string,
	addresses: readonly string[],
): HolderSteers {
	return {
		inboxes: addresses.map((address) => inboxOf(root, address)),
		wakes: WAKING_STEERS,
	};
}

/**
 * Ask the holder of every parked peer whose steer inbox under `root`
 * holds a steer that wakes it ({@link steerWakes}) to wake it, the
 * steer's file named as why;
 * answers the sessions asked for. The steer stays where it is, for the
 * peer to take as it starts.
 */
export function wakeSteered(
	everyone: readonly Presence[],
	root: string,
	isParked: (session: string) => boolean,
	askWake: (session: string, why: string) => void,
): string[] {
	const woken: string[] = [];
	for (const one of everyone) {
		if (!saysParked(one) || !isParked(one.session)) continue;
		const waking = one.addresses
			.flatMap((address) => waitingSteers(inboxOf(root, address)))
			.find(steerWakes);
		if (waking === undefined) continue;
		try {
			askWake(one.session, `steer-${waking.file}`);
			woken.push(one.session);
		} catch {
			// Unwoken, it takes the steer at its next start all the same.
		}
	}
	return woken;
}

/**
 * Ask the holder of every parked peer this message would give a turn to
 * wake it; answers the sessions asked for.
 */
export function wakeParked(
	message: Message,
	everyone: readonly Presence[],
	read: Reader,
	isParked: (session: string) => boolean,
	askWake: (session: string, messageId: string) => void,
): string[] {
	const woken: string[] = [];
	const sender = everyone.find((one) => one.addresses.includes(message.from));
	for (const one of everyone) {
		if (!saysParked(one) || !isParked(one.session)) continue;
		if (!wakes(message, one, read, sender)) continue;
		try {
			askWake(one.session, message.id);
			woken.push(one.session);
		} catch {
			// Unwoken, it reads the message at its next start all the same.
		}
	}
	return woken;
}

/** A steer file's ending once it is whole in its inbox. */
const READY = ".json";

/** A watch of a parked peer's steer inboxes, until it is closed. */
export interface SteerWatch {
	/** Stop watching: no steer landing after asks for anything. */
	close(): void;
}

/**
 * Watch the inboxes under `root` of every address in `addresses`, and
 * say `waking` with a steer's file each time one lands that waits on
 * the peer running, one already waiting included. Any steers waking at
 * once are said once, by the first of them, and each stays where it is
 * for the peer to take as it starts.
 *
 * Each address's inbox is watched where it is. An inbox made after the
 * watch starts, or swept by forgetInboxes and made again, is heard
 * through a watch on the steer root that heeds only these addresses'
 * folders.
 */
export function watchWakingSteers(options: {
	readonly root: string;
	readonly addresses: readonly string[];
	readonly waking: (file: string) => void;
	readonly report: (error: unknown) => void;
}): SteerWatch {
	const { root, report } = options;
	const addresses = new Set(options.addresses.map((one) => one.toUpperCase()));
	const inboxes = new Map<string, FSWatcher>();
	const asked = new Set<string>();
	let closed = false;
	let rootWatch: FSWatcher | undefined;

	function look(address: string): void {
		if (closed) return;
		const fresh = waitingSteers(inboxOf(root, address)).filter(
			(steer) => steerWakes(steer) && !asked.has(steer.file),
		);
		const first = fresh[0];
		if (first === undefined) return;
		for (const steer of fresh) asked.add(steer.file);
		options.waking(first.file);
	}

	function heed(address: string): void {
		if (closed) return;
		inboxes.get(address)?.close();
		inboxes.delete(address);
		try {
			const watcher = watch(inboxOf(root, address), (_, name) => {
				if (name?.endsWith(READY)) look(address);
			});
			watcher.unref();
			// A swept inbox ends its watch; the root's watch heeds it made again.
			watcher.on("error", () => {
				watcher.close();
				if (inboxes.get(address) === watcher) inboxes.delete(address);
			});
			inboxes.set(address, watcher);
		} catch {
			// No inbox yet: the root's watch heeds it once it is made.
		}
		// One landing before its watch began.
		look(address);
	}

	try {
		mkdirSync(root, { recursive: true });
		rootWatch = watch(root, (_, name) => {
			const address = name?.toUpperCase();
			if (address !== undefined && addresses.has(address)) heed(address);
		});
		rootWatch.unref();
		rootWatch.on("error", report);
	} catch (error) {
		// Only its inboxes there now are heard, and the backstop pass the rest.
		report(error);
	}
	for (const address of addresses) heed(address);

	return {
		close() {
			closed = true;
			rootWatch?.close();
			for (const watcher of inboxes.values()) watcher.close();
			inboxes.clear();
		},
	};
}
