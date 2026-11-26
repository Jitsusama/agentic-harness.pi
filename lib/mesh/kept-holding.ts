/**
 * What a hosted conversation signed with as it ended, and since when,
 * kept by its process for its next start there.
 *
 * A plain pi's presence stays a day after it ends, saying when, so its
 * next start reads its holding time from it (address.ts). A hosted
 * conversation's presence goes as it ends (peer/runs.ts), since the
 * host it names runs on. A conversation closed and reopened in its
 * host, and a rollover there, start again in that same process, the old
 * session ending before the new one starts, so the time is kept here
 * instead, and signedSince bounds it as it would bound the presence. A
 * host turns down a restart in place, so a reopen is its restart. A host's own restart parks what it
 * brings back, and a parked presence stays. A conversation that starts
 * again in another process keeps nothing and starts afresh: one the host
 * hands to a plain pi, and one a host running each conversation in a
 * child of its own reopens, since the child ends as it closes.
 *
 * Held on the process rather than a module, since a reload loads every
 * module afresh, as lib/internal/session/left.ts holds its marks. Each
 * keep drops what is past the bound, which no start could take, so a
 * host running for weeks holds only what ended in its last minutes.
 */

import type { Owner } from "../core/process/process.ts";
import { RESTARTED_WITHIN_MS, signedSince } from "./address.ts";

/** A holding as signedSince reads it, said ended when it was kept. */
export interface KeptHolding {
	readonly addresses: readonly string[];
	readonly signsSince: string;
	readonly ended: string;
	readonly at: string;
}

/** The key the process's map is held under, on `globalThis`. */
export const KEPT_KEY = Symbol.for("agentic-harness.mesh.kept-holding");

type KeptGlobal = { [KEPT_KEY]?: Map<string, KeptHolding> };

/** The process's one map, by session, made on first use. */
function kept(): Map<string, KeptHolding> {
	const global = globalThis as KeptGlobal;
	global[KEPT_KEY] ??= new Map();
	return global[KEPT_KEY];
}

/**
 * Keep what `presence` signs with, as its session ends at `ended`, and
 * drop every holding that ended more than a restart from it; a presence
 * that says no time holds nothing to keep.
 */
export function keepHolding(
	presence: {
		readonly session: string;
		readonly addresses: readonly string[];
		readonly signsSince?: string;
	},
	ended: string,
): void {
	const map = kept();
	const now = Date.parse(ended);
	for (const [session, holding] of map) {
		// Either way, as signedSince bounds it, so a clock set back drops it too.
		if (!(Math.abs(now - Date.parse(holding.ended)) <= RESTARTED_WITHIN_MS)) {
			map.delete(session);
		}
	}
	const { session, addresses, signsSince } = presence;
	if (signsSince === undefined) return;
	map.set(session, { addresses, signsSince, ended, at: ended });
}

/** Take what `session` kept as it ended, once: the next start has it. */
function takeHolding(session: string): KeptHolding | undefined {
	const holding = kept().get(session);
	kept().delete(session);
	return holding;
}

/**
 * What a session starting at `now` signs with and since when, taking
 * what it, or the session it rolled over from (`previous`), kept here
 * as it ended, so neither seeds a later start. Its last presence
 * (`before`) decides wherever there is one, even one saying no time,
 * since that one yielded since. Where none stands, its own kept holding
 * does, within the bound; the one it rolled from only where its own is
 * gone or past it, since a session rolled over to reads that one again
 * at each of its starts, and the log it left could since have held the
 * address afresh.
 */
export function takeHeldAtStart(
	before: Parameters<typeof signedSince>[0],
	at: {
		readonly session: string;
		readonly previous?: string;
		readonly owner?: Owner;
	},
	now: number,
): ReturnType<typeof signedSince> {
	const own = takeHolding(at.session);
	const carried =
		at.previous === undefined ? undefined : takeHolding(at.previous);
	if (before !== undefined) {
		return signedSince(before, now, { owner: at.owner });
	}
	return signedSince(own, now) ?? signedSince(carried, now);
}
