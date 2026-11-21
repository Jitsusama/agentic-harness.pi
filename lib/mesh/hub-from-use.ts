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
 * talked to, and being talked to is no warrant.
 */

import { questAddress } from "./address.ts";
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
 * the live cell on a quest above its own that it is most tied to, its
 * ties to each of that cell's addresses added up, since one cell can be
 * written to by its signature and by its quest's address. Equal ties go
 * to the cell whose single tie is strongest. A cell that has stopped
 * this one is never its hub, since it would not be written to.
 *
 * Only the quests its quest group spells are above it, and that group
 * names at most the six nearest levels, its own among them (scope.ts),
 * so at most five quests above it are searched.
 *
 * A hub is written to by the address it signs with, which another
 * cell's presence says; one that isn't shaped as a peer's address, such
 * as a group's name, is never a hub, so a presence can't widen where
 * `orchestrator` reaches.
 *
 * `ties` is this cell's, strongest first, as the node keeps them;
 * missing when no node answered.
 */
export function hubFromUse(
	self: Pick<Presence, "session" | "addresses" | "groups" | "joined" | "quest">,
	live: readonly Presence[],
	ties: readonly Tie[] | undefined,
): Above {
	if (self.quest === undefined) {
		return {
			none: "this peer is on no quest, so no orchestrator or hub from use is above it",
		};
	}
	const unmarked = `no orchestrator is above this peer's quest, ${self.quest},`;
	// Its own quest is the last of its chain; every one before it is above.
	const above = new Set(questChainOf(self).slice(0, -1));
	if (above.size === 0) {
		return {
			none: `${unmarked} and no quest is above it to find a hub from use in`,
		};
	}
	if (ties === undefined) {
		return {
			none: `${unmarked} and no ties came from the node (none answered, or it listed none) to find its hub from use`,
		};
	}
	const stoppers = new Set(
		stoppedBy(self, live).map(({ stopper }) => stopper.session),
	);
	const candidates = live.filter((one) => {
		if (one.session === self.session || stoppers.has(one.session)) {
			return false;
		}
		const own = questChainOf(one).at(-1);
		return own !== undefined && above.has(own) && one.addresses.some(isAddress);
	});
	// Strongest first, so the first cell to reach a sum keeps it on a tie.
	const strength = new Map<Presence, number>();
	for (const tie of ties) {
		const hub = candidates.find((one) => one.addresses.includes(tie.other));
		if (hub !== undefined) {
			strength.set(hub, (strength.get(hub) ?? 0) + tie.strength);
		}
	}
	let best: { hub: Presence; strength: number } | undefined;
	for (const [hub, sum] of strength) {
		if (best === undefined || sum > best.strength)
			best = { hub, strength: sum };
	}
	const address = best?.hub.addresses.find(isAddress);
	if (address !== undefined) return { address, by: "use" };
	return {
		none: `${unmarked} and no live cell on a quest above it has a tie to this peer yet`,
	};
}

/**
 * A cell's quest chain, root first, as the quest group its work puts it
 * in spells it: never a quest group it joined to hear, and the one that
 * ends in its own quest where it says which that is. An older presence
 * that lists no joined groups had joined every group it is in, as the
 * peer reads it (peer.ts), so it has no chain and is never a hub.
 */
function questChainOf(
	one: Pick<Presence, "groups" | "joined" | "quest">,
): string[] {
	const joined = new Set(one.joined ?? one.groups);
	const chains = one.groups
		.filter((group) => group.startsWith(QUEST_GROUP) && !joined.has(group))
		.map((group) => group.slice(QUEST_GROUP.length).split("/").filter(Boolean));
	const own = one.quest ? questAddress(one.quest).toLowerCase() : undefined;
	return (
		chains.find((chain) => own !== undefined && chain.at(-1) === own) ??
		(own === undefined && chains.length === 1 ? chains[0] : undefined) ??
		[]
	);
}
