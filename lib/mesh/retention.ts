/**
 * Retention: how long the mesh keeps what it holds, and the sweep that
 * lets go of the rest.
 *
 * Nothing on the mesh is a record anyone is owed: a message matters
 * while it can still be answered, a presence while its peer is there or
 * a sender should be told it has ended, a lease while it stands. Kept
 * past that, every listing and every read grows with the machine's
 * history rather than its present, so the mesh lets go on a schedule:
 *
 * - a message, a week after it was sent, which outlives any hold (two
 *   hours), any catch-up after a reload (an hour) and any thread a peer
 *   would still answer into;
 * - a read marker, once its peer has read nothing for that week, so a
 *   peer that ended is not remembered for ever;
 * - an ended peer's presence, a day after it last changed, so senders
 *   are told it has ended for a day and then forget it; or a week, when
 *   it stopped another peer, since the stop lives in its presence and a
 *   session restored within the week would otherwise come back without
 *   it, while what the stopped peer sent is still there to reach it;
 * - a peer's leases, once none of them stands.
 *
 * Any peer sweeps, at most once an hour, off its own turn: each removal
 * is of a file only the sweep would take, so peers sweeping at once
 * only race to the same end.
 */

import type { Board } from "./lease.ts";
import { type Census, census } from "./liveness.ts";
import type { Presence, Presences } from "./presence.ts";
import type { Transport } from "./transport.ts";

const HOUR_MS = 60 * 60 * 1000;

/** How long a message, and a marker nobody moved, is kept. */
export const KEEP_MS = 7 * 24 * HOUR_MS;

/** How long an ended peer's presence is kept after it last changed. */
export const ENDED_MS = 24 * HOUR_MS;

/** How often one peer sweeps, at most. */
export const SWEEP_EVERY_MS = HOUR_MS;

/** What the mesh keeps, each of which lets go of its own. */
export interface Kept {
	readonly transport: Transport;
	readonly presences: Presences;
	readonly board: Board;
}

/** Let go of everything past its time, as of now. */
export async function sweep(
	kept: Kept,
	now: number = Date.now(),
	// Which peers have ended: the machine's census, or a test's.
	ended: (everyone: readonly Presence[]) => Promise<Census> = census,
): Promise<void> {
	kept.transport.expire(now - KEEP_MS);
	kept.board.expire(now);
	kept.presences.expire(now - KEEP_MS);
	const { gone } = await ended(kept.presences.all());
	for (const one of gone) {
		const at = Date.parse(one.at);
		const lasts = (one.stops?.length ?? 0) > 0 ? KEEP_MS : ENDED_MS;
		if (Number.isFinite(at) && at < now - lasts) {
			kept.presences.forget(one.session);
		}
	}
}

/**
 * A sweep to call as often as is handy: it runs at most once an hour in
 * this process, never waits and never throws, since nothing a peer is
 * doing should hang on tidying.
 */
export function sweeper(
	kept: Kept,
	every: number = SWEEP_EVERY_MS,
	clock: () => number = Date.now,
): () => void {
	let last = Number.NEGATIVE_INFINITY;
	return () => {
		const now = clock();
		if (now - last < every) return;
		last = now;
		void sweep(kept, now).catch(() => {});
	};
}
