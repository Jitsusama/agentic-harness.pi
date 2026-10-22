/**
 * This session's own peer on the mesh: who it is, which groups it is
 * in, and the presence it publishes.
 *
 * A peer's addresses follow the quest it has loaded, so they are looked
 * up again whenever they might have changed, and each time its presence
 * is published afresh. It is in two kinds of group: those its work puts
 * it in (its scopes, see scope.ts), which are worked out again with its
 * work, and those it joined, which are its own to change and survive a
 * reload, because they are kept with its presence.
 *
 * Presence is published when something in it changes (its addresses,
 * its work, its groups, whether it is mid-run), never on a clock, so a
 * peer at rest writes nothing however long it rests.
 */

import type { Owner } from "@jitsusama/agentic-harness.core/process";

import {
	addressesOf,
	olderAddresses,
	type QuestRecords,
	signaturesOfOthers,
} from "./address.ts";
import type { Receiver } from "./attention.ts";
import type { Listener } from "./message.ts";
import { type Presence, type Presences, workOf } from "./presence.ts";

export interface Peer {
	readonly session: string;
	/** The addresses it answers to, the one it signs with first. */
	readonly addresses: readonly string[];
	/** The address it signs with. */
	readonly signature: string;
	/** Every group it is in, its scopes and those it joined, sorted. */
	readonly groups: readonly string[];
	/** The groups its work puts it in, sorted. */
	readonly scopes: readonly string[];
	/** The groups it joined itself, sorted. */
	readonly joined: readonly string[];
	/** Who messages reach, as `reaches` asks. */
	readonly listener: Listener;
	/** What it works on and owns, as attention asks. */
	readonly receiver: Receiver;
	/** Whether it is in the middle of a run. */
	readonly busy: boolean;
	/** Look its addresses and work up again, and publish any change. */
	refresh(): void;
	/** Say whether it is in the middle of a run. */
	setBusy(busy: boolean): void;
	/** Join a canonical group; answers whether it was new. */
	join(group: string): boolean;
	/**
	 * Leave a canonical group it joined; answers whether it had. A scope
	 * is not left this way: it follows the work.
	 */
	leave(group: string): boolean;
}

/** Where a peer finds what it needs to know about itself. */
export interface Surroundings {
	readonly session: string;
	readonly cwd: string;
	readonly records: QuestRecords;
	readonly presences: Presences;
	/** The process holding this session, when the machine would say. */
	readonly owner?: Owner;
}

/** This session's peer, with the groups it last joined. */
export function localPeer(at: Surroundings): Peer {
	const before = at.presences.of(at.session);
	let joined = [...(before?.joined ?? before?.groups ?? [])].sort();
	let scopes: string[] = [];
	let addresses: string[] = [];
	// Found once a start: reading every README on each refresh would
	// cost a few hundred file reads per message.
	const older = olderAddresses(at.session, at.records);
	let receiver: Receiver = { addresses, worksOn: "", owns: [] };
	let busy = false;
	const groups = () => [...new Set([...scopes, ...joined])].sort();
	// What was last published, less its time, so an unchanged presence is
	// not written again.
	let published: string | undefined;
	const publish = () => {
		const said: Omit<Presence, "at"> = {
			session: at.session,
			addresses,
			groups: groups(),
			joined,
			worksOn: receiver.worksOn,
			owns: receiver.owns,
			busy,
			...(at.owner ? { owner: at.owner } : {}),
		};
		const text = JSON.stringify(said);
		if (text === published) return;
		try {
			at.presences.publish({ ...said, at: new Date().toISOString() });
			published = text;
		} catch {
			// Unpublished, this peer still hears its groups until it ends;
			// it is only other senders who cannot see it there.
		}
	};
	const refresh = () => {
		addresses = addressesOf(
			at.session,
			at.records,
			older,
			signaturesOfOthers(at.session, at.presences.all()),
		);
		const work = workOf(at.session, joined, at.cwd, at.records);
		scopes = [...work.scopes];
		receiver = { addresses, worksOn: work.worksOn, owns: work.owns };
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
			return groups();
		},
		get scopes() {
			return scopes;
		},
		get joined() {
			return joined;
		},
		get listener() {
			return { addresses, groups: groups() };
		},
		get receiver() {
			return receiver;
		},
		get busy() {
			return busy;
		},
		refresh,
		setBusy(now) {
			busy = now;
			publish();
		},
		join(group) {
			if (joined.includes(group)) return false;
			joined = [...joined, group].sort();
			refresh();
			return true;
		},
		leave(group) {
			if (!joined.includes(group)) return false;
			joined = joined.filter((one) => one !== group);
			refresh();
			return true;
		},
	};
}
