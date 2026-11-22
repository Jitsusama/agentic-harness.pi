/**
 * Who `orchestrator` reaches for this peer: its quest's orchestrator
 * when the mark names one, else its hub from use
 * (lib/mesh/hub-from-use.ts). Finding the hub asks the node for this
 * peer's ties, which a send can wait on, so a send finds it afresh
 * every time. What the mesh says by itself (tells.ts, delivery.ts)
 * can't wait on the node while it says it, so each peer also keeps the
 * hub it last found (`keepHub`), checked again whenever it is read
 * against the peer's roles, its quest and the hub's presence as they
 * stand then.
 */

import { answeringTo } from "../../../lib/mesh/address.ts";
import {
	type Above,
	hubFromUse,
	questsAbove,
	stillAbove,
} from "../../../lib/mesh/hub-from-use.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import { type Local, peers } from "./local.ts";

/** What finding the hub reads of this peer. */
export type HubReading = Pick<Local, "peer" | "presences" | "ties">;

/** Where `orchestrator` points, when it points anywhere. */
export type Reached = Extract<Above, { address: string }>;

/** How often a kept hub is found again, since ties change by the hour. */
export const HUB_KEEP_MS = 5 * 60_000;

/**
 * How soon a find that could not finish is tried again: one that threw,
 * came before this peer's presence, or had no answer from the node.
 */
export const HUB_RETRY_MS = 30_000;

/** What a find came to, and whether it could be finished. */
export interface Found {
	readonly above: Above;
	/** False when it should be tried again soon rather than in a while. */
	readonly settled: boolean;
	/**
	 * The sessions the find's census judged no longer on the mesh, though
	 * their presences may not say so: a crashed session never writes that
	 * it ended. None where the find took no census.
	 */
	readonly gone: readonly string[];
}

/** Where this peer's `orchestrator` points, or why nowhere. */
export async function aboveFor(at: HubReading): Promise<Above> {
	return (await findAbove(at)).above;
}

/**
 * Where this peer's `orchestrator` points, and whether the find could be
 * finished: one with no presence yet, or no answer from the node, can't
 * say that nothing is above.
 */
export async function findAbove(at: HubReading): Promise<Found> {
	const mark = at.peer.orchestratedBy;
	if (mark !== undefined) {
		return { above: { address: mark, by: "mark" }, settled: true, gone: [] };
	}
	// A quest that heads an orchestration carries the mark itself, so it
	// has an orchestrator, its head: a hub above it would be a second
	// voice over the work it leads, for the head and for any other
	// session on the quest alike.
	if (at.peer.orchestrates !== undefined) {
		return {
			above: {
				none: "this peer heads its own orchestration, so nothing is above it for `orchestrator` to reach",
			},
			settled: true,
			gone: [],
		};
	}
	if (at.peer.questHeads !== undefined) {
		return {
			above: {
				none: `this peer's quest heads its own orchestration, whose head is ${at.peer.questHeads}, so nothing is above it for \`orchestrator\` to reach; write to ${at.peer.questHeads} by its address`,
			},
			settled: true,
			gone: [],
		};
	}
	const standing = await peers(at);
	const gone = standing.gone.map((one) => one.session);
	if (!standing.present.some((one) => one.session === at.peer.session)) {
		return {
			above: {
				none: "this peer has no presence on the mesh yet, so no orchestrator or hub from use is above it",
			},
			settled: false,
			gone,
		};
	}
	// A peer with nothing above it has no hub to find, so the node isn't
	// asked for ties that could change nothing.
	const self = asItStands(at.peer);
	if (self.quest === undefined || questsAbove(self).length === 0) {
		return {
			above: hubFromUse(self, standing.present, undefined, standing.gone),
			settled: true,
			gone,
		};
	}
	const ties = at.ties ? await at.ties() : undefined;
	return {
		above: hubFromUse(self, standing.present, ties, standing.gone),
		settled: at.ties === undefined || ties !== undefined,
		gone,
	};
}

/**
 * This peer as finding its hub reads it: its addresses, groups, stops
 * and quest as the peer holds them, never as a presence file says them.
 * Anything that can write the folder can add a file under this session,
 * and a file can lag a move to another quest, so read from there they
 * could choose which quests are above it, or a hub for the quest it
 * just left.
 */
function asItStands(
	peer: HubReading["peer"],
): Pick<
	Presence,
	"session" | "addresses" | "groups" | "joined" | "quest" | "stops"
> {
	return {
		session: peer.session,
		addresses: peer.addresses,
		groups: peer.groups,
		joined: peer.joined,
		stops: peer.stops,
		...(peer.quest === undefined ? {} : { quest: peer.quest }),
	};
}

/** Whether a peer's own roles leave it to find a hub from use. */
function unmarked(peer: HubReading["peer"]): boolean {
	return (
		peer.orchestratedBy === undefined &&
		peer.orchestrates === undefined &&
		peer.questHeads === undefined
	);
}

/** A peer's hub from use, found now and again, and read without waiting. */
export interface KeptHub {
	/** The hub last found, if it still holds as the peer stands now. */
	current(): string | undefined;
	/** Stop finding it again, and keep none. */
	stop(): void;
}

/** How often a kept hub is found, and who hears when one is. */
export interface HubKeeping {
	/** Milliseconds from one finished find to the next. */
	readonly every?: number;
	/** Milliseconds to the next find after one that could not finish. */
	readonly retry?: number;
	/**
	 * Called each time a find keeps a hub, so what waited for one is told
	 * whether the hub is new, back, or the one kept before.
	 */
	readonly found?: (address: string) => void;
}

/**
 * Keep the hub from use of whatever peer `at` gives, found at once and
 * again `every` milliseconds after each find, or `retry` after one that
 * could not finish. A peer under the mark, or on a quest heading an
 * orchestration, keeps none and never asks the node, since the mark is
 * its orchestrator; a find that fails keeps none rather than one that
 * may be gone.
 *
 * Reading it checks again, without waiting, what may have changed since
 * the last find: a peer that has taken a role since has no hub, nor has
 * one whose quest is no longer below the hub's, nor one whose hub's
 * address is now listed by no live presence, or by more than one. Live
 * is as the last find's census judged it, less any presence that has
 * said since that it ended, since a census can wait and a read can't:
 * so a session that crashed is no second holder, and a hub that stopped
 * without saying so is kept until the next find.
 */
export function keepHub(
	at: () => HubReading | undefined,
	{ every = HUB_KEEP_MS, retry = HUB_RETRY_MS, found }: HubKeeping = {},
): KeptHub {
	let kept: string | undefined;
	let gone: ReadonlySet<string> = new Set();
	let stopped = false;
	let clock: ReturnType<typeof setTimeout> | undefined;
	// Each find schedules the next once it ends, so two never overlap.
	const after = (wait: number) => {
		if (stopped) return;
		clock = setTimeout(() => void find(), wait);
		clock.unref?.();
	};
	const find = async () => {
		const reading = at();
		if (reading === undefined) {
			kept = undefined;
			after(retry);
			return;
		}
		if (!unmarked(reading.peer)) {
			kept = undefined;
			after(every);
			return;
		}
		let wait = every;
		try {
			const finding = await findAbove(reading);
			// Stopped while it asked: what it found is no longer this
			// peer's to keep.
			if (stopped) return;
			kept = "address" in finding.above ? finding.above.address : undefined;
			gone = new Set(finding.gone);
			if (!finding.settled) wait = retry;
		} catch {
			// The node or presences unreadable now: no hub is better than a
			// stale one, and the find is tried again soon.
			if (stopped) return;
			kept = undefined;
			wait = retry;
		}
		after(wait);
		if (kept === undefined) return;
		try {
			found?.(kept);
		} catch {
			// What the listener failed to say is its own to keep and try
			// again: the hub this find kept still holds.
		}
	};
	void find();
	return {
		current: () => {
			const address = kept;
			if (stopped || address === undefined) return undefined;
			const reading = at();
			if (reading === undefined || !unmarked(reading.peer)) return undefined;
			// Read as the find's census was: each presence answering only to
			// the addresses no other signs with, as `peers` gives them.
			const everyone = reading.presences.all();
			const live = everyone
				.filter((one) => one.ended === undefined && !gone.has(one.session))
				.map((one) => ({ ...one, addresses: answeringTo(one, everyone) }));
			if (!live.some((one) => one.session === reading.peer.session)) {
				return undefined;
			}
			return stillAbove(asItStands(reading.peer), live, address)
				? address
				: undefined;
		},
		stop: () => {
			stopped = true;
			kept = undefined;
			if (clock !== undefined) clearTimeout(clock);
		},
	};
}

/**
 * Where what the mesh says by itself goes for this peer: the mark's
 * orchestrator, else the hub it last found from use, else nowhere.
 */
export function keptAbove(
	orchestratedBy: string | undefined,
	hub: KeptHub | undefined,
): Reached | undefined {
	if (orchestratedBy !== undefined) {
		return { address: orchestratedBy, by: "mark" };
	}
	const address = hub?.current();
	return address === undefined ? undefined : { address, by: "use" };
}
