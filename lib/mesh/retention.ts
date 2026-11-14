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
 * - a peer's leases, once none of them stands;
 * - a steer inbox no present peer answers: an empty one an hour after
 *   it was made, one holding anything a week after it last changed,
 *   since a session restored within the week takes up its address and
 *   whatever steer still waits there.
 *
 * Any peer sweeps, at most once an hour on the machine, off its own
 * turn: each removal is of a file only the sweep would take, so peers
 * sweeping at once only race to the same end.
 */

import { readFileSync } from "node:fs";
import { writeWhole } from "../internal/write-whole.ts";

import type { Board } from "./lease.ts";
import { type Census, census } from "./liveness.ts";
import type { Presence, Presences } from "./presence.ts";
import { forgetInboxes } from "./steer.ts";
import type { Transport } from "./transport.ts";

const HOUR_MS = 60 * 60 * 1000;

/** How long a message, and a marker nobody moved, is kept. */
export const KEEP_MS = 7 * 24 * HOUR_MS;

/**
 * How long a message stays where every peer looks for new ones, before
 * it moves to its day's folder: past the two hours the unanswered list
 * looks back, and past an hour's turn of a busy session.
 */
export const RECENT_MS = 6 * HOUR_MS;

/** How long an ended peer's presence is kept after it last changed. */
export const ENDED_MS = 24 * HOUR_MS;

/** How often the machine sweeps, at most. */
export const SWEEP_EVERY_MS = HOUR_MS;

/** The file in the mesh's folder that says when it was last swept. */
export const SWEPT_STAMP = ".swept";

/** What the mesh keeps, each of which lets go of its own. */
export interface Kept {
	readonly transport: Transport;
	readonly presences: Presences;
	readonly board: Board;
	/** The steer inboxes' folder, one per address, when the mesh has one. */
	readonly inboxes?: string;
}

/** Let go of everything past its time, as of now. */
export async function sweep(
	kept: Kept,
	now: number = Date.now(),
	// Which peers have ended: the machine's census, or a test's.
	ended: (everyone: readonly Presence[]) => Promise<Census> = census,
): Promise<void> {
	kept.transport.settle(now - RECENT_MS);
	kept.transport.expire(now - KEEP_MS);
	kept.board.expire(now);
	kept.presences.expire(now - KEEP_MS);
	const { present, gone } = await ended(kept.presences.all());
	if (kept.inboxes !== undefined) {
		const answered = new Set(present.flatMap((one) => one.addresses));
		forgetInboxes(kept.inboxes, answered, now - HOUR_MS, now - KEEP_MS);
	}
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
 * this process and never throws, since nothing a peer is doing should
 * hang on tidying. It hands back the sweep, which never rejects, for a
 * caller that wants to know it is done; a peer leaves it unawaited.
 *
 * Given a stamp file, the hour is the machine's rather than this
 * sweeper's: each sweep writes its time there, and a sweeper that reads
 * a time within the hour sweeps nothing. A host makes a sweeper for each
 * conversation it starts, and on 14 November each one woken swept the
 * whole mesh again, 0.67 s of a 4.4 s wake on the host's one thread.
 */
export function sweeper(
	kept: Kept,
	every: number = SWEEP_EVERY_MS,
	clock: () => number = Date.now,
	stamp?: string,
): () => Promise<void> {
	let last = Number.NEGATIVE_INFINITY;
	return () => {
		const now = clock();
		if (now - last < every) return Promise.resolve();
		if (stamp !== undefined) {
			const swept = sweptAt(stamp);
			if (swept !== undefined && now - swept < every && swept <= now) {
				last = swept;
				return Promise.resolve();
			}
			markSwept(stamp, now);
		}
		last = now;
		return sweep(kept, now).catch(() => {
			// A sweep that fails leaves what it could not tidy for the next.
		});
	};
}

/** When the machine last swept, by its stamp, or nothing when unknown. */
function sweptAt(stamp: string): number | undefined {
	try {
		const at = Number(readFileSync(stamp, "utf8"));
		return Number.isFinite(at) ? at : undefined;
	} catch {
		// No stamp yet, or one that can't be read: sweep, as before stamps.
		return undefined;
	}
}

function markSwept(stamp: string, now: number): void {
	try {
		writeWhole(stamp, String(now));
	} catch {
		// Unwritten, the next sweeper sweeps too: the same end, sooner.
	}
}
