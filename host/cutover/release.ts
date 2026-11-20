/**
 * Releasing hosted conversations back to plain pi, as the rollback a
 * cutover can always take.
 *
 * Each chosen conversation is told to move to `pi` (lib/mesh/steer.ts)
 * and woken if it is parked, as a cutover wakes the ones it moves, so it
 * ends itself the moment nothing holds it and its host drops it,
 * leaving a move note that restore.json offers back
 * (lib/internal/quest/reopening/restore-file.ts), whatever the boot, until a plain
 * pi starts it again from the same file. The release refreshes that
 * file the look each one leaves, so the launcher's Sessions to Reopen
 * shows it, and writes to each one's quest journal what only the host
 * held: its screen, which any viewer was attached to, and what the
 * conversation waited for before it closed.
 *
 * Each is opened again the moment it has gone, not once the last has:
 * on 15 November a drill released ten, and the six that left at once
 * sat off the mesh with no pi until the release ended, one of them
 * mid-merge (OSPHT4 [e8c33ae1]). A window viewing one carries it on in
 * plain pi by itself (host/service/join.ts), so the release gives that
 * window {@link REOPEN_GRACE_MS} to start it, and hands only one nothing
 * took up to the launcher, as Reopen Them All opens it. One the launcher
 * won't take stays offered in Sessions to Reopen.
 *
 * A release that reaches its deadline, or is stopped, calls off every
 * move still waiting with a `resume` steer, as the person at the desk
 * would (mesh-workflow moving.ts), so none leaves later with nothing
 * there to open it. Those stay in their host.
 */

import type { MoveNote } from "../../lib/internal/session/move.ts";
import type { HostKind } from "../service/address.ts";

/** A conversation one of the realm's hosts holds. */
export interface HeldConversation {
	readonly session: string;
	/** The host holding it, by key (`work-attended`). */
	readonly host: string;
	readonly kind: HostKind;
}

/** A kind of host whose list couldn't be had, and why. */
export interface UnreadHost {
	readonly kind: HostKind;
	readonly why: string;
}

/**
 * One look at the realm's hosts: what they hold, and each kind whose
 * list couldn't be had, whose holdings are then unknown, not none.
 */
export interface HostsLook {
	readonly held: readonly HeldConversation[];
	readonly unread: readonly UnreadHost[];
}

/** Why each unread host's list couldn't be had, as one line. */
function saidOf(unread: readonly UnreadHost[]): string {
	return unread.map((one) => one.why).join("; ");
}

/** What a release asks of the machine; tests give their own. */
export interface ReleaseFacts {
	/** What the realm's two hosts hold now, each kind's on its own. */
	held(): Promise<HostsLook>;
	/** The addresses a conversation answers to, its signature first. */
	addressesOf(session: string): readonly string[];
	/** Ask the conversation going by `address` to move to plain pi. */
	tell(address: string): void;
	/**
	 * Wake the conversation if it is parked, so it starts and reads what it
	 * was told; nothing for one running.
	 */
	wake(session: string): void;
	/** The move note a session left, if any. */
	note(session: string): MoveNote | undefined;
	/** What holds a conversation from ending now, as its presence says. */
	holds(session: string): Promise<string | undefined>;
	/** Whether a pi runs the session again since it left its host. */
	takenUp(session: string): boolean;
	/**
	 * Hand a conversation let go to the launcher to open in plain pi, as
	 * Reopen Them All does; whether it took it.
	 */
	reopen(note: MoveNote): Promise<boolean>;
	/** Call off the move the conversation going by `address` waits on. */
	callOff(address: string): void;
	/** Write restore.json again, so the launcher offers what was let go. */
	refreshRestore(): void;
	/** Add a Journey entry to a quest's README; whether it could. */
	journal(quest: string, prose: string): boolean;
	now(): number;
	pause(ms: number): Promise<void>;
	say(line: string): void;
}

/**
 * Where a conversation let go went on: the window viewing it carried it
 * on, the launcher opened it, or Sessions to Reopen offers it.
 */
export type Opened = "window" | "launcher" | "offered";

/** One conversation let go, and what only the host held of it. */
export interface Released {
	readonly address: string;
	readonly session: string;
	readonly from: string;
	readonly at: string;
	/** What held it before it closed, in the order seen. */
	readonly waitedFor: readonly string[];
	readonly opened: Opened;
	readonly quest?: string;
	/** Whether its quest's journal took the entry. */
	readonly journaled: boolean;
}

/** What a release did. */
export interface ReleaseReport {
	readonly released: readonly Released[];
	/**
	 * Still held at the deadline or the stop, its move called off, with
	 * what held each last.
	 */
	readonly waiting: readonly { address: string; holds?: string }[];
	/** Gone from its host without a note, so nothing offers it back. */
	readonly lost: readonly string[];
	/** Named, but no host holds it. */
	readonly unknown: readonly string[];
}

/** How often the release looks again while conversations close. */
export const RELEASE_LOOK_MS = 2_000;

/**
 * How long a window viewing a conversation has to carry it on in plain
 * pi once its host lets it go, before the release opens it elsewhere. The
 * window looks every quarter second and its pi settles the note as it
 * starts, which a loaded machine takes seconds to reach; opened beside
 * it, the log would have two writers.
 */
export const REOPEN_GRACE_MS = 15_000;

/** What a release may be told beyond its names and deadline. */
interface ReleaseOptions {
	/** False to only offer each in Sessions to Reopen, opening none. */
	readonly reopen?: boolean;
	/** Ends the wait as the deadline would, as on SIGINT or SIGTERM. */
	readonly stop?: AbortSignal;
}

/** How the journal says where a conversation went on. */
const WENT_ON: Record<Opened, string> = {
	window:
		"and carried on in plain pi in the window viewing it, from the same file.",
	launcher:
		"and the launcher reopened it in plain pi from the same file, as Reopen Them All does.",
	offered:
		"and waits in the launcher's Sessions to Reopen to open from the same file.",
};

/** How the release's own lines say where a conversation went on. */
const SAID_OPENED: Record<Opened, string> = {
	window: "its window carried it on",
	launcher: "the launcher reopened it",
	offered: "offered in Sessions to Reopen",
};

/** Which held conversations `names` picks: addresses or session ids. */
export function chooseReleased(
	held: readonly HeldConversation[],
	addressesOf: (session: string) => readonly string[],
	names: readonly string[] | "all",
): { chosen: HeldConversation[]; unknown: string[] } {
	if (names === "all") return { chosen: [...held], unknown: [] };
	const chosen: HeldConversation[] = [];
	const unknown: string[] = [];
	for (const name of names) {
		const wanted = name.toUpperCase();
		const one = held.find(
			(each) =>
				each.session === name ||
				addressesOf(each.session).some(
					(address) => address.toUpperCase() === wanted,
				),
		);
		if (!one) unknown.push(name);
		else if (!chosen.includes(one)) chosen.push(one);
	}
	return { chosen, unknown };
}

/** What a quest's journal says of a conversation let go. */
export function releaseProse(one: Omit<Released, "journaled">): string {
	const waited =
		one.waitedFor.length === 0
			? "It closed at once, holding nothing."
			: `Before it closed it waited while ${one.waitedFor.join("; then while ")}.`;
	return [
		`${one.address} was released from the ${one.from} host back to plain pi at ${one.at}, ${WENT_ON[one.opened]}`,
		waited,
		one.opened === "window"
			? "Only the host held its screen, so any other viewer closed with it."
			: "Only the host held its screen, so any viewer closed with it.",
	].join(" ");
}

/** A conversation gone from its host, not yet settled where it went on. */
interface Departed {
	readonly one: HeldConversation;
	/** When the release saw it gone, as `now` counts. */
	readonly at: number;
}

/**
 * Tell each chosen conversation to move to plain pi and wait, until
 * the time `deadline` (as `now` counts) or a stop, for each to close,
 * opening each again and journaling it as it goes; then call off the
 * moves of those still held.
 */
export async function releaseBack(
	names: readonly string[] | "all",
	facts: ReleaseFacts,
	deadline: number,
	options: ReleaseOptions = {},
): Promise<ReleaseReport> {
	const first = await facts.held();
	if (first.unread.length > 0)
		throw new Error(
			`Nothing was released, since ${saidOf(first.unread)}; run it again once the hosts answer`,
		);
	const { chosen, unknown } = chooseReleased(
		first.held,
		(session) => facts.addressesOf(session),
		names,
	);
	// Read now: a conversation's presence goes when it closes.
	const addresses = new Map(
		chosen.map((one) => [
			one.session,
			facts.addressesOf(one.session)[0] ?? one.session,
		]),
	);
	const addressOf = (session: string) => addresses.get(session) ?? session;
	const waitedFor = new Map<string, string[]>();
	for (const one of chosen) {
		facts.tell(addressOf(one.session));
		// A parked one reads its inbox only once it runs, and nothing else
		// need be running to wake it overnight.
		facts.wake(one.session);
		facts.say(`told ${addressOf(one.session)} to move back to pi`);
		waitedFor.set(one.session, []);
	}
	const left = new Map(chosen.map((one) => [one.session, one]));
	const departed = new Map<string, Departed>();
	// Read as each leaves, since the pi that takes it up settles its note.
	const notes = new Map<string, MoveNote>();
	const lastHolds = new Map<string, string | undefined>();
	const released: Released[] = [];
	const lost: string[] = [];
	const reopening = options.reopen !== false;
	let calledOff = false;
	// A pi that starts on a session settles the note it left, so a note
	// seen as it left and gone since says one took it up.
	const takenUpNow = (session: string) =>
		facts.takenUp(session) ||
		(notes.has(session) && facts.note(session) === undefined);
	const settle = async (session: string, one: HeldConversation) => {
		const address = addressOf(session);
		const note = notes.get(session) ?? facts.note(session);
		const takenUp = takenUpNow(session);
		if (note?.to !== "pi" && !takenUp) {
			lost.push(address);
			facts.say(`${address} closed without a note; not offered`);
			return;
		}
		const opened: Opened = takenUp
			? "window"
			: reopening && note && (await facts.reopen(note))
				? "launcher"
				: "offered";
		const base = {
			address,
			session,
			from: note?.from ?? one.host,
			at: note?.at ?? new Date(facts.now()).toISOString(),
			waitedFor: waitedFor.get(session) ?? [],
			opened,
			...(note?.quest ? { quest: note.quest } : {}),
		};
		const journaled = base.quest
			? facts.journal(base.quest, releaseProse(base))
			: false;
		released.push({ ...base, journaled });
		facts.say(
			`${address} released from the ${base.from} host; ${SAID_OPENED[opened]}`,
		);
	};
	let unread: readonly UnreadHost[] = [];
	for (;;) {
		const look = await facts.held();
		const why = look.unread.length > 0 ? saidOf(look.unread) : undefined;
		const before = unread.length > 0 ? saidOf(unread) : undefined;
		if (why !== undefined && why !== before)
			facts.say(`looking again, as ${why}`);
		if (why === undefined && before !== undefined)
			facts.say("the hosts answer again");
		unread = look.unread;
		// One whose host didn't answer counts as still there: read as
		// gone, one still held would be settled with no note, and lost.
		const unanswered = new Set(look.unread.map((one) => one.kind));
		const still = new Set([
			...look.held.map((one) => one.session),
			...[...left.values()]
				.filter((one) => unanswered.has(one.kind))
				.map((one) => one.session),
		]);
		let leaving = false;
		for (const [session, one] of left) {
			if (still.has(session)) {
				const holds = await facts.holds(session);
				lastHolds.set(session, holds);
				const seen = waitedFor.get(session) ?? [];
				if (holds && seen.at(-1) !== holds) {
					seen.push(holds);
					facts.say(`${addressOf(session)} waits: ${holds}`);
				}
				continue;
			}
			left.delete(session);
			departed.set(session, { one, at: facts.now() });
			const note = facts.note(session);
			if (note) notes.set(session, note);
			leaving = true;
		}
		if (leaving) facts.refreshRestore();
		for (const [session, { one, at }] of departed) {
			// Only one about to be opened waits out a window's grace.
			const early = facts.now() - at < REOPEN_GRACE_MS;
			if (reopening && early && !takenUpNow(session)) continue;
			departed.delete(session);
			await settle(session, one);
		}
		const over = facts.now() >= deadline || options.stop?.aborted === true;
		if (over && !calledOff) {
			calledOff = true;
			const unanswered = new Map(unread.map((one) => [one.kind, one.why]));
			for (const [session, one] of left) {
				facts.callOff(addressOf(session));
				const unseen = unanswered.get(one.kind);
				if (unseen === undefined) {
					facts.say(`called off ${addressOf(session)}'s move; it stays hosted`);
					continue;
				}
				// Its host never answered at the end, so it may have left.
				const holds = `whether it left is unknown, as ${unseen}`;
				lastHolds.set(session, holds);
				facts.say(`called off ${addressOf(session)}'s move; ${holds}`);
			}
		}
		if (departed.size === 0 && (left.size === 0 || calledOff)) break;
		await facts.pause(RELEASE_LOOK_MS);
	}
	facts.refreshRestore();
	return {
		released,
		waiting: [...left.keys()].map((session) => {
			const holds = lastHolds.get(session);
			return { address: addressOf(session), ...(holds ? { holds } : {}) };
		}),
		lost,
		unknown,
	};
}
