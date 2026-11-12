/**
 * Releasing hosted conversations back to plain pi, as the rollback a
 * cutover can always take.
 *
 * Each chosen conversation is told to move to `pi` (lib/mesh/steer.ts)
 * and woken if it is parked, as a cutover wakes the ones it moves, so it
 * ends itself the moment nothing holds it and its host drops it,
 * leaving a move note that restore.json offers back
 * (lib/internal/quest/restore-file.ts), whatever the boot, until a plain
 * pi starts it again from the same file. The release refreshes that
 * file at once, so the launcher's Sessions to Reopen shows them, and
 * writes to each one's quest journal what only the host held: its
 * screen, which any viewer was attached to, and what the conversation
 * waited for before it closed.
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

/** What a release asks of the machine; tests give their own. */
export interface ReleaseFacts {
	/** Every conversation the realm's two hosts hold now. */
	held(): Promise<HeldConversation[]>;
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
	/** Write restore.json again, so the launcher offers what was let go. */
	refreshRestore(): void;
	/** Add a Journey entry to a quest's README; whether it could. */
	journal(quest: string, prose: string): boolean;
	now(): number;
	pause(ms: number): Promise<void>;
	say(line: string): void;
}

/** One conversation let go, and what only the host held of it. */
export interface Released {
	readonly address: string;
	readonly session: string;
	readonly from: string;
	readonly at: string;
	/** What held it before it closed, in the order seen. */
	readonly waitedFor: readonly string[];
	readonly quest?: string;
	/** Whether its quest's journal took the entry. */
	readonly journaled: boolean;
}

/** What a release did. */
export interface ReleaseReport {
	readonly released: readonly Released[];
	/** Still held at the deadline, with what held each last. */
	readonly waiting: readonly { address: string; holds?: string }[];
	/** Gone from its host without a note, so nothing offers it back. */
	readonly lost: readonly string[];
	/** Named, but no host holds it. */
	readonly unknown: readonly string[];
}

/** How often the release looks again while conversations close. */
export const RELEASE_LOOK_MS = 2_000;

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
		`${one.address} was released from the ${one.from} host back to plain pi at ${one.at}, and waits in the launcher's Sessions to Reopen to open from the same file.`,
		waited,
		"Only the host held its screen, so a window viewing it through its holder carried on there as plain pi, and any other viewer closed with it.",
	].join(" ");
}

/**
 * Tell each chosen conversation to move to plain pi and wait, until
 * the time `deadline` (as `now` counts), for each to close; then offer
 * them back and journal each.
 */
export async function releaseBack(
	names: readonly string[] | "all",
	facts: ReleaseFacts,
	deadline: number,
): Promise<ReleaseReport> {
	const { chosen, unknown } = chooseReleased(
		await facts.held(),
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
	const gone: HeldConversation[] = [];
	const lastHolds = new Map<string, string | undefined>();
	for (;;) {
		const still = new Set((await facts.held()).map((one) => one.session));
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
			gone.push(one);
		}
		if (left.size === 0 || facts.now() >= deadline) break;
		await facts.pause(RELEASE_LOOK_MS);
	}
	facts.refreshRestore();
	const released: Released[] = [];
	const lost: string[] = [];
	for (const one of gone) {
		const address = addressOf(one.session);
		const note = facts.note(one.session);
		if (note?.to !== "pi") {
			lost.push(address);
			facts.say(`${address} closed without a note; not offered`);
			continue;
		}
		const base = {
			address,
			session: one.session,
			from: note.from ?? one.host,
			at: note.at,
			waitedFor: waitedFor.get(one.session) ?? [],
			...(note.quest ? { quest: note.quest } : {}),
		};
		const journaled = note.quest
			? facts.journal(note.quest, releaseProse(base))
			: false;
		released.push({ ...base, journaled });
		facts.say(`${address} released from the ${base.from} host`);
	}
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
