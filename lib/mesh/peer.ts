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
 * its work, its groups, whether it is mid-run, what it waits on its
 * person for), never on a clock, so a peer at rest writes nothing
 * however long it rests.
 *
 * What it waits on is never kept across a start, since whatever asked
 * belonged to the process that ended.
 */

import type { Owner } from "@jitsusama/agentic-harness.core/process";
import type { Orchestration } from "../internal/quest/orchestration.ts";
import {
	addressesOf,
	loadedAddress,
	olderAddresses,
	type QuestRecords,
	questAddress,
	signaturesOfOthers,
	yieldsTo,
} from "./address.ts";
import type { Receiver } from "./attention.ts";
import type { Listener } from "./message.ts";
import { type Presence, type Presences, workOf } from "./presence.ts";
import type { Stop } from "./stop.ts";
import { longestStanding, type Want, type WantKind } from "./want.ts";

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
	/** The peers it has stopped reaching it (see stop.ts). */
	readonly stops: readonly Stop[];
	/** Who messages reach, as `reaches` asks. */
	readonly listener: Listener;
	/** What it works on and owns, as attention asks. */
	readonly receiver: Receiver;
	/** Whether it is in the middle of a run. */
	readonly busy: boolean;
	/**
	 * The address of the orchestrator its quest answers to, when one is
	 * above it.
	 */
	readonly orchestratedBy: string | undefined;
	/**
	 * The address of the orchestration it heads, when its quest
	 * orchestrates and this is the session playing the role.
	 */
	readonly orchestrates: string | undefined;
	/** What it waits on its person for, standing longest (see want.ts). */
	readonly wants: Want | undefined;
	/**
	 * The live peer it left its quest's address to, since that peer
	 * already signed with it (see address.ts).
	 */
	readonly yieldedTo: Presence | undefined;
	/** Say it waits on its person for this, in place of any of its kind. */
	want(want: Want): void;
	/** Say it no longer waits for this kind; answers whether it did. */
	settle(kind: WantKind): boolean;
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
	/** Stop a peer reaching this one; answers whether it was new. */
	stop(stop: Stop): boolean;
	/** Lift the stop on an address; answers whether there was one. */
	lift(address: string): Stop | undefined;
}

/** Where a peer finds what it needs to know about itself. */
export interface Surroundings {
	readonly session: string;
	readonly cwd: string;
	readonly records: QuestRecords;
	readonly presences: Presences;
	/** The process holding this session, when the machine would say. */
	readonly owner?: Owner;
	/**
	 * The session this one carries on from, when pi rolled its log over
	 * into a fresh one: the same peer under a new session id.
	 */
	readonly previous?: string;
	/**
	 * The sessions last counted still there (see liveness.ts), or nothing
	 * before any count, when every presence is taken as there.
	 */
	readonly live?: () => ReadonlySet<string> | undefined;
	/**
	 * The window title pi gives this session now, read at each publish so
	 * a rename reaches presence with the next thing the peer says.
	 */
	readonly title?: () => string | undefined;
}

/** A presence's title field, when there is a title to say. */
function titled(title: string | undefined): { title?: string } {
	return title ? { title } : {};
}

/**
 * What a peer says of the orchestrations it is in: the orchestrator its
 * quest answers to, and the one it heads, which only the session signing
 * with the orchestrating quest's address does. That is the session that
 * had the quest first, since a later one leaves the address to it (see
 * address.ts), so two sessions on one orchestrating quest never both
 * play the role.
 */
export function orchestrationRoles(
	orchestration: Orchestration,
	signature: string | undefined,
): { orchestratedBy?: string; orchestrates?: string } {
	const heads = orchestration.heads
		? questAddress(orchestration.heads)
		: undefined;
	return {
		...(orchestration.by
			? { orchestratedBy: questAddress(orchestration.by) }
			: {}),
		...(heads && heads === signature ? { orchestrates: heads } : {}),
	};
}

/** This session's peer, with the groups it last joined. */
export function localPeer(at: Surroundings): Peer {
	// A peer carried on from an earlier session is the same peer: it takes
	// that session's presence as its own, and the presence is forgotten,
	// so nobody signs with its addresses and this peer keeps them.
	const carried =
		at.previous !== undefined && at.previous !== at.session
			? at.presences.of(at.previous)
			: undefined;
	if (carried) at.presences.forget(carried.session);
	const before = at.presences.of(at.session) ?? carried;
	let joined = [...(before?.joined ?? before?.groups ?? [])].sort();
	let stops: Stop[] = [...(before?.stops ?? [])];
	let scopes: string[] = [];
	let addresses: string[] = [];
	// Found once a start: reading every README on each refresh would
	// cost a few hundred file reads per message.
	const older = [
		...new Set([
			...olderAddresses(at.session, at.records),
			...(carried?.addresses ?? []),
		]),
	];
	let receiver: Receiver = { addresses, worksOn: "", owns: [] };
	let roles: { orchestratedBy?: string; orchestrates?: string } = {};
	let busy = false;
	const wanting = new Map<WantKind, Want>();
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
			...(stops.length > 0 ? { stops } : {}),
			worksOn: receiver.worksOn,
			owns: receiver.owns,
			busy,
			...(wanting.size > 0 ? { wants: longestStanding(wanting.values()) } : {}),
			...(at.owner ? { owner: at.owner } : {}),
			...titled(at.title?.()),
			...roles,
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
	let yieldedTo: Presence | undefined;
	const refresh = () => {
		const everyone = at.presences.all();
		const counted = at.live?.();
		const live = counted
			? everyone.filter((one) => counted.has(one.session))
			: everyone;
		const signing = loadedAddress(at.session, at.records);
		yieldedTo = yieldsTo(
			at.session,
			signing,
			signing !== undefined && addresses[0] === signing,
			live,
		);
		addresses = addressesOf(
			at.session,
			at.records,
			older,
			signaturesOfOthers(at.session, everyone),
			yieldedTo !== undefined,
		);
		const work = workOf(at.session, joined, at.cwd, at.records);
		scopes = [...work.scopes];
		receiver = { addresses, worksOn: work.worksOn, owns: work.owns };
		roles = orchestrationRoles(work.orchestration, addresses[0]);
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
		get stops() {
			return stops;
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
		get orchestratedBy() {
			return roles.orchestratedBy;
		},
		get orchestrates() {
			return roles.orchestrates;
		},
		get wants() {
			return longestStanding(wanting.values());
		},
		get yieldedTo() {
			return yieldedTo;
		},
		want(want) {
			wanting.set(want.kind, want);
			publish();
		},
		settle(kind) {
			if (!wanting.delete(kind)) return false;
			publish();
			return true;
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
		stop(stop) {
			if (stops.some((one) => one.address === stop.address)) return false;
			stops = [...stops, stop];
			publish();
			return true;
		},
		lift(address) {
			const lifted = stops.find((one) => one.address === address);
			if (!lifted) return undefined;
			stops = stops.filter((one) => one !== lifted);
			publish();
			return lifted;
		},
	};
}
