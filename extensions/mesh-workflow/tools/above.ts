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
 * came before this peer's presence, or had no answer from the node. Each
 * find in a row the node gave no answer to waits twice as long, up to a
 * keeping's wait, since every session asks the same node and one that is
 * down is better asked less and less often. The cost is a slow return:
 * a peer whose node comes back keeps no hub until its next find, up to
 * a keeping's wait away, unless a send of its own hears the node answer
 * first (`KeptHub.nodeAnswered`).
 */
export const HUB_RETRY_MS = 30_000;

/**
 * The least any wait between finds may be, so a keeping given no wait
 * never asks the node in a loop.
 */
const HUB_LEAST_WAIT_MS = 1;

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
	/**
	 * True when the find ended before it could ask the node, so it says
	 * nothing of whether the node answers.
	 */
	readonly unasked?: true;
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
			unasked: true,
		};
	}
	// A peer with nothing above it has no hub to find, so the node isn't
	// asked for ties that could change nothing.
	const self = asItStands(at.peer, at.presences.all());
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
 * and quest as the peer holds them now, rather than as its presence file
 * last said them. Another process can overwrite the file until the
 * peer's next refresh puts it back, and a publish that failed leaves it
 * as it was; read from there, it could find a hub for a quest this peer
 * isn't on. This covers those two and no more. The peer's own values
 * come from the same user's session records and quest files, and its
 * joined groups and stops are seeded from this presence when the peer
 * is built: a file rewritten before then can add a joined group that
 * picks which quests are above, or drop a stop, until the session
 * changes them itself. Its addresses are those it still answers to, as
 * the census reads every presence: an older quest's address that a
 * newer session now signs with is that session's, and a stop aimed at
 * it is no stop of this peer's.
 */
function asItStands(
	peer: HubReading["peer"],
	everyone: readonly Presence[],
): Pick<
	Presence,
	"session" | "addresses" | "groups" | "joined" | "quest" | "stops"
> {
	return {
		session: peer.session,
		addresses: answeringTo(peer, everyone),
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
	/**
	 * The hub last found, if it still holds as the peer stands now. Given
	 * `gone`, the sessions a census newer than the last find's judged gone,
	 * that census alone says who is live, since it judged every presence
	 * the last one did and more lately.
	 */
	current(gone?: readonly string[]): string | undefined;
	/**
	 * Find again now if the last finds had no answer from the node, since
	 * something else has just heard it answer; otherwise nothing.
	 */
	nodeAnswered(): void;
	/** Stop finding it again, and keep none. */
	stop(): void;
}

/** How often a kept hub is found, and who hears when one is. */
export interface HubKeeping {
	/** Milliseconds from one finished find to the next. */
	readonly every?: number;
	/**
	 * Milliseconds to the next find after one that could not finish,
	 * doubled for each after it in a row, up to `every`.
	 */
	readonly retry?: number;
	/**
	 * A fraction from 0 up to 1 of `HUB_SPREAD` added to each wait, so
	 * sessions that started together, or lost the node together, drift
	 * apart rather than asking it in the same instant; random unless given.
	 */
	readonly spread?: () => number;
	/**
	 * Called each time a find keeps a hub, so what waited for one is told
	 * whether the hub is new, back, or the one kept before.
	 */
	readonly found?: (address: string) => void;
}

/** How often a kept hub is found, as a session's mesh is told to. */
export type HubTiming = Pick<HubKeeping, "every" | "retry" | "spread">;

/**
 * The most a wait is lengthened by, as a share of it: enough that a
 * host's sessions, restored in one go, stop asking the node in step
 * within a few finds, while a hub is still found within about six
 * minutes at the slowest.
 */
const HUB_SPREAD = 0.2;

/**
 * Keep the hub from use of whatever peer `at` gives, found at once and
 * again `every` milliseconds after each find, or `retry` after one that
 * could not finish, twice that after a second in a row, and so on up to
 * `every`, each wait lengthened by up to a fifth at random. A find
 * that throws, which only reading the presences can do, comes a plain
 * `retry` later and counts nothing toward the doubling, as does one
 * with no peer to read yet or no presence of this peer's, since none of
 * them says the node is down. A peer under the
 * mark, or on a quest heading an orchestration, keeps none and never
 * asks the node, since the mark is its orchestrator; a find that fails
 * keeps none rather than one that may be gone.
 *
 * Reading it checks again, without waiting, what may have changed since
 * the last find: a peer that has taken a role since has no hub, nor has
 * one whose hub no longer passes the rules the find chose it by
 * (`stillAbove`): its address listed by its live presence alone, that
 * one on a quest above, and neither having stopped the other. Live
 * is as the last find's census judged it, or a newer census given to
 * the read, less any presence that has said since that it ended, since
 * a census can wait and a read can't: so a session that crashed is no
 * second holder, and a hub that stopped without saying so is kept until
 * the next find or census.
 */
export function keepHub(
	at: () => HubReading | undefined,
	{
		every = HUB_KEEP_MS,
		retry = HUB_RETRY_MS,
		spread = Math.random,
		found,
	}: HubKeeping = {},
): KeptHub {
	let kept: string | undefined;
	let gone: ReadonlySet<string> = new Set();
	let stopped = false;
	let clock: ReturnType<typeof setTimeout> | undefined;
	// Finds in a row that could not finish, so each waits longer.
	let misses = 0;
	// Set while a find waits on the node, so a nudge starts no second one.
	let asking = false;
	const longest = Math.max(HUB_LEAST_WAIT_MS, every);
	const soonest = Math.max(HUB_LEAST_WAIT_MS, retry);
	const backingOff = () => {
		const wait = Math.min(longest, soonest * 2 ** misses);
		// Counted no further once the wait is the longest, so it stays a number.
		if (wait < longest) misses += 1;
		return wait;
	};
	// Each find schedules the next once it ends, so two never overlap.
	const after = (wait: number) => {
		if (stopped) return;
		clock = setTimeout(() => void find(), wait * (1 + HUB_SPREAD * spread()));
		clock.unref?.();
	};
	const find = async () => {
		const reading = at();
		// No peer to read yet says nothing of the node, so it doesn't
		// lengthen the wait a node that is down has earned.
		if (reading === undefined) {
			kept = undefined;
			after(soonest);
			return;
		}
		if (!unmarked(reading.peer)) {
			kept = undefined;
			misses = 0;
			after(longest);
			return;
		}
		let wait = longest;
		asking = true;
		try {
			const finding = await findAbove(reading);
			// Stopped while it asked: what it found is no longer this
			// peer's to keep.
			if (stopped) return;
			kept = "address" in finding.above ? finding.above.address : undefined;
			gone = new Set(finding.gone);
			if (finding.settled) misses = 0;
			else wait = finding.unasked ? soonest : backingOff();
		} catch {
			// The presences unreadable now, since asking the node never
			// throws: no hub is better than a stale one, and the find is
			// tried again soon.
			if (stopped) return;
			kept = undefined;
			wait = soonest;
		} finally {
			asking = false;
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
		current: (newer) => {
			const address = kept;
			if (stopped || address === undefined) return undefined;
			const reading = at();
			if (reading === undefined || !unmarked(reading.peer)) return undefined;
			// Read as the find's census was: each presence answering only to
			// the addresses no other signs with, as `peers` gives them.
			const all = reading.presences.all();
			const everyone = all.map((one) => ({
				...one,
				addresses: answeringTo(one, all),
			}));
			const isGone = (one: Presence) =>
				one.ended !== undefined ||
				(newer === undefined
					? gone.has(one.session)
					: newer.includes(one.session));
			const live = everyone.filter((one) => !isGone(one));
			const ended = everyone.filter(isGone);
			if (!live.some((one) => one.session === reading.peer.session)) {
				return undefined;
			}
			return stillAbove(asItStands(reading.peer, all), live, address, ended)
				? address
				: undefined;
		},
		nodeAnswered: () => {
			if (stopped || misses === 0 || asking) return;
			if (clock !== undefined) clearTimeout(clock);
			void find();
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
