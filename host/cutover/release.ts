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

/** A host that listens but didn't say what it holds, and why. */
export interface UnheardHost {
	readonly kind: HostKind;
	readonly why: string;
}

/** What one look at the realm's two hosts found. */
export interface HostsLook {
	readonly held: readonly HeldConversation[];
	/**
	 * Each host that listens but didn't say, as one too loaded to answer
	 * in time: what it holds is unknown, never none.
	 */
	readonly unheard: readonly UnheardHost[];
}

/** What a release asks of the machine; tests give their own. */
export interface ReleaseFacts {
	/** Every conversation the realm's two hosts hold now, and which didn't say. */
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
	/**
	 * Why the release's last look didn't hear every host, when it didn't:
	 * what it says of those still waiting is then unknown.
	 */
	readonly unheard?: string;
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

/** How often the release says again that a host it can't hear stays unheard. */
export const UNHEARD_SAY_MS = 60_000;

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

/**
 * What the realm's hosts hold now. A look that fails as a whole hears
 * neither host, so it leaves every conversation unknown, never gone.
 */
async function heldNow(facts: ReleaseFacts): Promise<HostsLook> {
	try {
		return await facts.held();
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		return {
			held: [],
			unheard: [
				{ kind: "attended", why },
				{ kind: "background", why },
			],
		};
	}
}

/** Why a look didn't hear every host, in a line; undefined when it did. */
function unheardOf(look: HostsLook): string | undefined {
	const whys = [...new Set(look.unheard.map((one) => one.why))];
	return whys.length === 0 ? undefined : whys.join("; ");
}

/**
 * Say a host went unheard as the reason changes, and again once a
 * minute while it stays, so a long silence never reads as a hang.
 */
function unheardSayer(facts: ReleaseFacts): (look: HostsLook) => void {
	let said: string | undefined;
	let saidAt = 0;
	return (look) => {
		const why = unheardOf(look);
		if (why === undefined) {
			said = undefined;
			return;
		}
		if (why === said && facts.now() - saidAt < UNHEARD_SAY_MS) return;
		facts.say(
			why === said ? `still looking again: ${why}` : `looking again: ${why}`,
		);
		said = why;
		saidAt = facts.now();
	};
}

/**
 * The first look, which chooses what to release: taken again until it
 * hears every host, or every named one is found among the hosts it
 * heard, so a host too loaded to answer never reads as holding none of
 * them. Undefined when no such look came before the deadline or a stop.
 */
async function firstLook(
	facts: ReleaseFacts,
	names: readonly string[] | "all",
	deadline: number,
	stop: AbortSignal | undefined,
	sayUnheard: (look: HostsLook) => void,
): Promise<
	| { chosen: HeldConversation[]; unknown: string[] }
	| { unheard: string; unknown: string[] }
> {
	for (;;) {
		const look = await heldNow(facts);
		const choice = chooseReleased(
			look.held,
			(session) => facts.addressesOf(session),
			names,
		);
		const unheard = unheardOf(look);
		if (
			unheard === undefined ||
			(names !== "all" && choice.unknown.length === 0)
		)
			return choice;
		sayUnheard(look);
		if (facts.now() >= deadline || stop?.aborted === true)
			return { unheard, unknown: choice.unknown };
		await facts.pause(RELEASE_LOOK_MS);
	}
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
	const sayUnheard = unheardSayer(facts);
	const first = await firstLook(
		facts,
		names,
		deadline,
		options.stop,
		sayUnheard,
	);
	// Nobody is told to move on a look that couldn't find them all.
	if ("unheard" in first)
		return {
			released: [],
			waiting: [],
			lost: [],
			unknown: first.unknown,
			unheard: first.unheard,
		};
	const { chosen, unknown } = first;
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
	let unheard: string | undefined;
	for (;;) {
		const look = await heldNow(facts);
		// A host too loaded to answer says nothing of who left it, so its
		// conversations are passed over rather than read as gone.
		sayUnheard(look);
		unheard = unheardOf(look);
		const still = new Set(look.held.map((one) => one.session));
		const unheardKinds = new Set(look.unheard.map((one) => one.kind));
		let leaving = false;
		for (const [session, { one }] of departed) {
			// Held again, as a host's list can miss one for a look while it
			// swaps its runtime: it never left, so it is waited on again.
			if (!still.has(session) || takenUpNow(session)) continue;
			departed.delete(session);
			notes.delete(session);
			left.set(session, one);
		}
		for (const [session, one] of left) {
			if (!still.has(session) && unheardKinds.has(one.kind)) continue;
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
		const over = facts.now() >= deadline || options.stop?.aborted === true;
		for (const [session, gone] of departed) {
			// Kept as it is found, so a pi settling it later says it took it up.
			const late = notes.has(session) ? undefined : facts.note(session);
			if (late) notes.set(session, late);
			const noted = notes.has(session);
			const takenUp = takenUpNow(session);
			// A look that didn't hear its host can't find it held again, so
			// one with no note waits its grace from the next look that does.
			if (!(noted || takenUp) && unheardKinds.has(gone.one.kind)) {
				// Out of time, nothing says it left: it is waited on still, and
				// called off with the rest, rather than named lost unseen.
				if (over && !calledOff) {
					departed.delete(session);
					left.set(session, gone.one);
				} else departed.set(session, { ...gone, at: facts.now() });
				continue;
			}
			// One about to be opened waits out a window's grace, and so does
			// one with no note yet, whose note may follow or which a look may
			// find held again.
			const early = facts.now() - gone.at < REOPEN_GRACE_MS;
			if (early && (reopening || !noted) && !takenUp) continue;
			departed.delete(session);
			await settle(session, gone.one);
		}
		if (over && !calledOff) {
			calledOff = true;
			for (const [session, one] of left) {
				const note = facts.note(session);
				if (!unheardKinds.has(one.kind) || note?.to !== "pi") continue;
				// Its host unheard, its note says it left for pi: settled where
				// it went on, never called off as though still hosted.
				left.delete(session);
				departed.set(session, { one, at: facts.now() });
				notes.set(session, note);
			}
			for (const session of left.keys()) {
				facts.callOff(addressOf(session));
				facts.say(`called off ${addressOf(session)}'s move; it stays hosted`);
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
		...(unheard === undefined ? {} : { unheard }),
	};
}
