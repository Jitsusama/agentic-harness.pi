/**
 * This session's own peer on the mesh: who it is, which groups it is
 * in, and the presence it publishes.
 *
 * A peer's addresses follow the quest it has loaded, so they are looked
 * up again whenever they might have changed, and each time its presence
 * is published afresh. Its groups are its own to change and survive a
 * reload, because they are kept with its presence.
 */

import { addressesOf, type QuestRecords } from "./address.ts";
import type { Receiver } from "./attention.ts";
import type { Listener } from "./message.ts";
import { type Presences, workOf } from "./presence.ts";

export interface Peer {
	readonly session: string;
	/** The addresses it answers to, the one it signs with first. */
	readonly addresses: readonly string[];
	/** The address it signs with. */
	readonly signature: string;
	/** The groups it joined, canonical and sorted. */
	readonly groups: readonly string[];
	/** Who messages reach, as `reaches` asks. */
	readonly listener: Listener;
	/** What it works on and owns, as attention asks. */
	readonly receiver: Receiver;
	/** Look its addresses and work up again, and publish them. */
	refresh(): void;
	/** Join a canonical group; answers whether it was new. */
	join(group: string): boolean;
	/** Leave a canonical group; answers whether it had been in it. */
	leave(group: string): boolean;
}

/** Where a peer finds what it needs to know about itself. */
export interface Surroundings {
	readonly session: string;
	readonly cwd: string;
	readonly records: QuestRecords;
	readonly presences: Presences;
}

/** This session's peer, with the groups it was last in. */
export function localPeer(at: Surroundings): Peer {
	let groups = [...(at.presences.of(at.session)?.groups ?? [])].sort();
	let addresses: string[] = [];
	let receiver: Receiver = { addresses, worksOn: "", owns: [] };
	const publish = () => {
		try {
			at.presences.publish({
				session: at.session,
				addresses,
				groups,
				worksOn: receiver.worksOn,
				owns: receiver.owns,
				at: new Date().toISOString(),
			});
		} catch {
			// Unpublished, this peer still hears its groups until it ends;
			// it is only other senders who cannot see it there.
		}
	};
	const refresh = () => {
		addresses = addressesOf(at.session, at.records);
		receiver = {
			addresses,
			...workOf(at.session, groups, at.cwd, at.records),
		};
		publish();
	};
	refresh();
	return {
		session: at.session,
		get addresses() {
			return addresses;
		},
		get signature() {
			return addresses[0] ?? at.session;
		},
		get groups() {
			return groups;
		},
		get listener() {
			return { addresses, groups };
		},
		get receiver() {
			return receiver;
		},
		refresh,
		join(group) {
			if (groups.includes(group)) return false;
			groups = [...groups, group].sort();
			refresh();
			return true;
		},
		leave(group) {
			if (!groups.includes(group)) return false;
			groups = groups.filter((one) => one !== group);
			refresh();
			return true;
		},
	};
}
