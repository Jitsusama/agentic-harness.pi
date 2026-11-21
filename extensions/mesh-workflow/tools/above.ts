/**
 * Who `orchestrator` reaches for this peer: its quest's orchestrator
 * when the mark names one, else its hub from use
 * (lib/mesh/hub-from-use.ts). Finding the hub asks the node for this
 * peer's ties, which a send can wait on, so a send finds it afresh
 * every time. What the mesh says by itself (tells.ts, delivery.ts)
 * can't wait on the node while it says it, so each peer also keeps the
 * hub it last found (`keepHub`), checked again whenever it is read
 * against the peer's roles and the hub's presence as they stand then.
 */

import {
	type Above,
	hubFromUse,
	lists,
	questsAbove,
} from "../../../lib/mesh/hub-from-use.ts";
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
interface Found {
	readonly above: Above;
	/** False when it should be tried again soon rather than in a while. */
	readonly settled: boolean;
}

/** Where this peer's `orchestrator` points, or why nowhere. */
export async function aboveFor(at: HubReading): Promise<Above> {
	return (await findAbove(at)).above;
}

async function findAbove(at: HubReading): Promise<Found> {
	const mark = at.peer.orchestratedBy;
	if (mark !== undefined) {
		return { above: { address: mark, by: "mark" }, settled: true };
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
		};
	}
	if (at.peer.questHeads !== undefined) {
		return {
			above: {
				none: `this peer's quest heads its own orchestration, whose head is ${at.peer.questHeads}, so nothing is above it for \`orchestrator\` to reach; write to ${at.peer.questHeads} by its address`,
			},
			settled: true,
		};
	}
	const standing = await peers(at);
	const self = standing.present.find((one) => one.session === at.peer.session);
	if (self === undefined) {
		return {
			above: {
				none: "this peer has no presence on the mesh yet, so no orchestrator or hub from use is above it",
			},
			settled: false,
		};
	}
	// A peer with nothing above it has no hub to find, so the node isn't
	// asked for ties that could change nothing.
	if (self.quest === undefined || questsAbove(self).length === 0) {
		return {
			above: hubFromUse(self, standing.present, undefined, standing.gone),
			settled: true,
		};
	}
	const ties = at.ties ? await at.ties() : undefined;
	return {
		above: hubFromUse(self, standing.present, ties, standing.gone),
		settled: at.ties === undefined || ties !== undefined,
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
	/** Called when a find turns up a hub where none was kept. */
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
 * the last find: a peer that has taken a role since has no hub, and
 * nor has one whose hub's every presence now says it ended. A hub that
 * stopped without saying so is kept until the next find.
 */
export function keepHub(
	at: () => HubReading | undefined,
	{ every = HUB_KEEP_MS, retry = HUB_RETRY_MS, found }: HubKeeping = {},
): KeptHub {
	let kept: string | undefined;
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
			const had = kept;
			kept = "address" in finding.above ? finding.above.address : undefined;
			if (!finding.settled) wait = retry;
			if (had === undefined && kept !== undefined) found?.(kept);
		} catch {
			// The node or presences unreadable now: no hub is better than a
			// stale one, and the find is tried again soon.
			if (stopped) return;
			kept = undefined;
			wait = retry;
		}
		after(wait);
	};
	void find();
	return {
		current: () => {
			const address = kept;
			if (stopped || address === undefined) return undefined;
			const reading = at();
			if (reading === undefined || !unmarked(reading.peer)) return undefined;
			const there = reading.presences
				.all()
				.some((one) => one.ended === undefined && lists(one, address));
			return there ? address : undefined;
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
