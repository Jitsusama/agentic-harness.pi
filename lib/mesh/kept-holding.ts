/**
 * What a hosted conversation signed with as it ended, and since when,
 * kept by its process for its next start there.
 *
 * A plain pi's presence stays a day after it ends, saying when, so its
 * next start reads its holding time from it (address.ts). A hosted
 * conversation's presence goes as it ends (peer/runs.ts), since the
 * host it names runs on. A restart in place and a rollover start again
 * in that same process, so the time is kept here instead, and
 * signedSince bounds it as it would bound the presence. A host's own
 * restart parks what it brings back, and a parked presence stays.
 *
 * Held on the process rather than a module, since a reload loads every
 * module afresh, as lib/internal/session/left.ts holds its marks.
 */

import { signedSince } from "./address.ts";

/** A holding as signedSince reads it, said ended when it was kept. */
export interface KeptHolding {
	readonly addresses: readonly string[];
	readonly signsSince: string;
	readonly ended: string;
	readonly at: string;
}

const KEPT_KEY = Symbol.for("agentic-harness.mesh.kept-holding");

type KeptGlobal = { [KEPT_KEY]?: Map<string, KeptHolding> };

/** The process's one map, by session, made on first use. */
function kept(): Map<string, KeptHolding> {
	const global = globalThis as KeptGlobal;
	global[KEPT_KEY] ??= new Map();
	return global[KEPT_KEY];
}

/**
 * Keep what `presence` signs with, as its session ends at `ended`; a
 * presence that says no time holds nothing to keep.
 */
export function keepHolding(
	presence: {
		readonly session: string;
		readonly addresses: readonly string[];
		readonly signsSince?: string;
	},
	ended: string,
): void {
	const { session, addresses, signsSince } = presence;
	if (signsSince === undefined) return;
	kept().set(session, { addresses, signsSince, ended, at: ended });
}

/** Take what `session` kept as it ended, once: the next start has it. */
function takeHolding(session: string): KeptHolding | undefined {
	const holding = kept().get(session);
	kept().delete(session);
	return holding;
}

/**
 * What a session starting at `now` signs with and since when: read from
 * its last presence (`before`) where that says, else from what it, or
 * the session it rolled over from (`previous`), kept here as it ended.
 * Both kept are taken, so neither seeds a later start.
 */
export function heldAtStart(
	before: Parameters<typeof signedSince>[0],
	session: string,
	previous: string | undefined,
	now: number,
): ReturnType<typeof signedSince> {
	const own = takeHolding(session);
	const carried = previous === undefined ? undefined : takeHolding(previous);
	return signedSince(before, now) ?? signedSince(own ?? carried, now);
}
