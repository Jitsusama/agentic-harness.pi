/**
 * Who `orchestrator` reaches for this peer: its quest's orchestrator
 * when the mark names one, else its hub from use
 * (lib/mesh/hub-from-use.ts). Finding the hub asks the node for this
 * peer's ties, and what the mesh says by itself (tells.ts, delivery.ts)
 * can't wait on the node while it says it, so each peer keeps the hub
 * it last found (`keepHub`). A send naming the word reads that one too,
 * and asks afresh only when none is kept.
 */

import { type Above, hubFromUse } from "../../../lib/mesh/hub-from-use.ts";
import { type Local, peers } from "./local.ts";

/** What finding the hub reads of this peer. */
export type HubReading = Pick<Local, "peer" | "presences" | "ties">;

/** Where `orchestrator` points, when it points anywhere. */
export type Reached = Extract<Above, { address: string }>;

/** How often a kept hub is found again, since ties change by the hour. */
export const HUB_KEEP_MS = 5 * 60_000;

/** Where this peer's `orchestrator` points, or why nowhere. */
export async function aboveFor(at: HubReading): Promise<Above> {
	const mark = at.peer.orchestratedBy;
	if (mark !== undefined) return { address: mark, by: "mark" };
	// A quest that heads an orchestration carries the mark itself, so it
	// has an orchestrator, its head: a hub above it would be a second
	// voice over the work it leads, for the head and for any other
	// session on the quest alike.
	if (at.peer.orchestrates !== undefined) {
		return {
			none: "this peer heads its own orchestration, so nothing is above it for `orchestrator` to reach",
		};
	}
	if (at.peer.questHeads !== undefined) {
		return {
			none: `this peer's quest heads its own orchestration, whose head is ${at.peer.questHeads}, so nothing is above it for \`orchestrator\` to reach; write to ${at.peer.questHeads} by its address`,
		};
	}
	const [standing, ties] = await Promise.all([
		peers(at),
		at.ties ? at.ties() : Promise.resolve(undefined),
	]);
	const self = standing.present.find((one) => one.session === at.peer.session);
	if (self === undefined) {
		return {
			none: "this peer has no presence on the mesh yet, so no orchestrator or hub from use is above it",
		};
	}
	return hubFromUse(self, standing.present, ties, standing.gone);
}

/** A peer's hub from use, found now and again, and read without waiting. */
export interface KeptHub {
	/** The hub last found, if any. */
	current(): string | undefined;
	/** Stop finding it again. */
	stop(): void;
}

/**
 * Keep the hub from use of whatever peer `at` gives, found at once and
 * every `every` milliseconds after. A peer under the mark, or on a
 * quest heading an orchestration, keeps none and never asks the node,
 * since the mark is its orchestrator; a find that fails keeps none rather than one
 * that may be gone.
 */
export function keepHub(
	at: () => HubReading | undefined,
	every = HUB_KEEP_MS,
): KeptHub {
	let kept: string | undefined;
	let finding = false;
	const find = async () => {
		const reading = at();
		if (
			reading === undefined ||
			reading.peer.orchestratedBy !== undefined ||
			reading.peer.orchestrates !== undefined ||
			reading.peer.questHeads !== undefined
		) {
			kept = undefined;
			return;
		}
		// A tick that comes while the last still asks is passed over.
		if (finding) return;
		finding = true;
		try {
			const above = await aboveFor(reading);
			kept = "address" in above ? above.address : undefined;
		} catch {
			// The node or presences unreadable now: no hub is better than a
			// stale one, and the next tick finds it again.
			kept = undefined;
		} finally {
			finding = false;
		}
	};
	void find();
	const clock = setInterval(() => void find(), every);
	clock.unref?.();
	return {
		current: () => kept,
		stop: () => clearInterval(clock),
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
