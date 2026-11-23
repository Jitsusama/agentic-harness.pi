/**
 * Who a cell's `orchestrator` is when its quest carries no orchestrator
 * mark: its hub from use, the live cell on a quest above its own that it
 * is most tied to, as the node keeps ties.
 *
 * A quest used to need the mark for its cells to have somewhere to send
 * what was for the work above them, so every quest that wanted a reader
 * had to sit in an orchestration. With this, a quest with the mark works
 * as before, and one without it gets the reader its own talk has already
 * chosen. A quest with neither has nobody above it, and the sender is
 * told so rather than the message going anywhere wider.
 *
 * The hub from use is only an address. It grants nothing: a pivot, an
 * end, a carry or a view over another cell's questions is still the
 * marked orchestrator's alone, since a cell becomes a hub by being
 * talked to, and being talked to is no warrant. Nor is talking at a
 * cell a way to become its hub: a tie counts for the share of today's
 * messages on it that this cell sent.
 */

import { questAddress } from "./address.ts";
import { groupNamed } from "./group.ts";
import type { Tie } from "./node.ts";
import type { Presence } from "./presence.ts";
import { isAddress } from "./steer-who.ts";
import { stoppedBy } from "./stop.ts";

/** Where a cell's `orchestrator` points, and why it points there. */
export type Above =
	| {
			/** The address it reaches. */
			readonly address: string;
			/** `mark` for its quest's orchestrator, `use` for its hub from use. */
			readonly by: "mark" | "use";
	  }
	| {
			/** Why nothing is above it, in words a refusal can say. */
			readonly none: string;
	  };

/** The group prefix every quest chain is said under (see scope.ts). */
const QUEST_GROUP = "#quest/";

/**
 * The hub from use of a cell whose quest carries no orchestrator mark:
 * the live cell on a quest above its own that it talks with most, its
 * ties to each of that cell's addresses added up, since one cell can be
 * written to by its signature and by its quest's address. Only a tie to
 * an address that could be the hub's counts, never one to a group or an
 * address two presences list. Equal ties go
 * to the cell whose single tie is strongest. A cell that has stopped
 * this one is never its hub, since it would not be written to, and nor
 * is one this cell has stopped, whose answer it would drop.
 *
 * Only the quests its quest group spells are above it, and that group
 * names at most the six nearest levels, its own among them (scope.ts),
 * so at most five quests above it are searched.
 *
 * A hub is written to by the address it signs with, which another
 * cell's presence says; one that isn't shaped as a peer's address, or
 * that a send reads as a group, as it reads `machine` and `global`, is
 * never a hub, so a presence can't widen where `orchestrator` reaches.
 * Nor is an address another live presence also lists, or an `ended`
 * one on another quest, which a forged presence could take to point
 * the send at a peer that isn't above: a send to an ended peer's
 * address still reaches it once it is restored. An ended session on the
 * live holder's own quest doesn't count, since a new session on a quest
 * signs with its address as the one before it did, and that one,
 * restored, is above as well.
 *
 * `ties` is this cell's, strongest first, as the node keeps them;
 * missing when no node answered.
 */
export function hubFromUse(
	self: Pick<
		Presence,
		"session" | "addresses" | "groups" | "joined" | "quest" | "stops"
	>,
	live: readonly Presence[],
	ties: readonly Tie[] | undefined,
	ended: readonly Presence[] = [],
): Above {
	if (self.quest === undefined) {
		return {
			none: "this peer is on no quest, so no orchestrator or hub from use is above it",
		};
	}
	const unmarked = `no orchestrator is above this peer's quest, ${self.quest},`;
	const above = new Set(questsAbove(self));
	if (above.size === 0) {
		return {
			none: `${unmarked} and no quest is above it to find a hub from use in`,
		};
	}
	if (ties === undefined) {
		return {
			none: `${unmarked} and no ties came from the node (none answered in time, or it keeps none) to find its hub from use`,
		};
	}
	const stoppers = new Set(
		stoppedBy(self, live).map(({ stopper }) => stopper.session),
	);
	// Held by exactly one live presence, and by no ended one on another
	// quest, so the cell it names is that one, in any case, since a send
	// reads an address upper-cased.
	const alone = (address: string) => {
		const [holder, ...others] = live.filter((one) => lists(one, address));
		if (holder === undefined || others.length > 0) return false;
		const quest = ownQuestOf(holder);
		return !ended.some(
			(one) => lists(one, address) && ownQuestOf(one) !== quest,
		);
	};
	const writable = (address: string) => isHub(address) && alone(address);
	const candidates = live.filter((one) => {
		if (
			one.session === self.session ||
			stoppers.has(one.session) ||
			stoppedHere(self, one)
		) {
			return false;
		}
		const own = ownQuestOf(one);
		return own !== undefined && above.has(own) && one.addresses.some(writable);
	});
	// Strongest first, so the first cell to reach a sum keeps it on a tie.
	const strength = new Map<Presence, number>();
	for (const tie of ties) {
		const share = ownShare(tie);
		if (share <= 0 || !writable(tie.other)) continue;
		const hub = candidates.find((one) => lists(one, tie.other));
		if (hub !== undefined) {
			strength.set(hub, (strength.get(hub) ?? 0) + share);
		}
	}
	let best: { hub: Presence; strength: number } | undefined;
	for (const [hub, sum] of strength) {
		if (best === undefined || sum > best.strength)
			best = { hub, strength: sum };
	}
	const address = best?.hub.addresses.find(writable);
	if (address !== undefined) return { address, by: "use" };
	return {
		none: `${unmarked} and no live cell on a quest above it has a tie to this peer yet`,
	};
}

/**
 * A tie's strength, counted for the share of today's messages on it
 * this cell sent, so a cell that has only written at this one today
 * gains nothing. Today is the last 24 hours, and the node keeps no tie
 * without a message in them, so one that reads none counts nothing
 * rather than letting talk of unknown sides through.
 */
function ownShare(tie: Tie): number {
	const [mine, theirs] = tie.today;
	const total = mine + theirs;
	return total > 0 ? (tie.strength * mine) / total : 0;
}

/** Whether `self` has stopped `one`, by its session or an address. */
function stoppedHere(
	self: Pick<Presence, "stops">,
	one: Pick<Presence, "session" | "addresses">,
): boolean {
	return (self.stops ?? []).some(
		(stop) => stop.session === one.session || lists(one, stop.address),
	);
}

/** Whether `one` lists `address`, in any case, as a send reads it. */
export function lists(
	one: Pick<Presence, "addresses">,
	address: string,
): boolean {
	const wanted = address.toUpperCase();
	return one.addresses.some((listed) => listed.toUpperCase() === wanted);
}

/**
 * Whether a hub can be written to at `address`: shaped as a peer's,
 * and read by a send as that one peer, never as a group such as the
 * machine's.
 */
function isHub(address: string): boolean {
	return (
		isAddress(address) && groupNamed(address) === `@${address.toUpperCase()}`
	);
}

/**
 * The quests above `one`'s own, root first: every one of its chain but
 * the last, which is its own. None where it has no chain, so a caller
 * can tell before asking the node whether a hub could be found at all.
 */
export function questsAbove(
	one: Pick<Presence, "groups" | "joined" | "quest">,
): string[] {
	return questChainOf(one).slice(0, -1);
}

/**
 * Whether a hub found earlier still stands as `self` reads it now: its
 * address listed by exactly one of the `live` presences, that one on a
 * quest above `self`'s, and neither having stopped the other, as the
 * find required when it chose it. A hub is kept while the node is
 * quiet, so this is the only check it meets until a find settles.
 */
export function stillAbove(
	self: Pick<
		Presence,
		"session" | "addresses" | "stops" | "groups" | "joined" | "quest"
	>,
	live: readonly Presence[],
	address: string,
): boolean {
	const [holder, ...others] = live.filter((one) => lists(one, address));
	if (holder === undefined || others.length > 0) return false;
	if (stoppedHere(self, holder) || stoppedHere(holder, self)) return false;
	const own = ownQuestOf(holder);
	return own !== undefined && questsAbove(self).includes(own);
}

/** The quest `one` works on, the last of its chain, if it has one. */
function ownQuestOf(
	one: Pick<Presence, "groups" | "joined" | "quest">,
): string | undefined {
	return questChainOf(one).at(-1);
}

/**
 * A cell's quest chain, root first, as the quest group its work puts it
 * in spells it. Where it says its quest, the chain is the group ending
 * in it, the one it works in over one it joined, since a group joined
 * before the quest was loaded stays joined, as may one joined before a
 * move, and one joined only to hear ends in another's quest.
 * Where it doesn't, it is its one quest group not joined to hear. An
 * older presence that lists no joined groups had joined every group it
 * is in, as the peer reads it (peer.ts), so it then has no chain and is
 * never a hub.
 */
function questChainOf(
	one: Pick<Presence, "groups" | "joined" | "quest">,
): string[] {
	const chainOf = (group: string) =>
		group.slice(QUEST_GROUP.length).split("/").filter(Boolean);
	if (one.joined === undefined) return [];
	const quests = one.groups.filter((group) => group.startsWith(QUEST_GROUP));
	const joined = new Set(one.joined);
	if (one.quest) {
		const own = questAddress(one.quest).toLowerCase();
		const ending = quests.filter((group) => chainOf(group).at(-1) === own);
		const chosen = ending.find((group) => !joined.has(group)) ?? ending[0];
		return chosen === undefined ? [] : chainOf(chosen);
	}
	const worked = quests.filter((group) => !joined.has(group));
	return worked.length === 1 ? chainOf(worked[0] ?? "") : [];
}
