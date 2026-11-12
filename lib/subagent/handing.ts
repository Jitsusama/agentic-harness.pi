/**
 * Who a fleet's subagents answer to once their session has moved on:
 * the run folder's `parent.json`, read by each child's supervisor ahead
 * of the parent its request named.
 *
 * A supervisor stops its child as `parent-exit` once the pi or hosted
 * conversation that dispatched it is gone, so a session moving into a
 * host used to take its fleet down with it. Now the moving pi writes
 * `{ handing }` here as it lets the fleet go (the fleet's job carry,
 * extensions/subagent-workflow/carry.ts), and the conversation that
 * takes it up writes `{ owner }`, itself, which the supervisor watches
 * from then on. The file goes once that conversation has said the
 * fleet's summary.
 *
 * The hand-over lasts as long as the move does: while the session's
 * move note is out, waiting for a cutover or claimed by one adopting
 * the log (lib/internal/session/move.ts), at most
 * {@link HANDING_MOST_MS}; then {@link HANDING_MARGIN_MS} more, for
 * whoever took the note up, a host or the plain pi its join fell back
 * to, to start the conversation and write its owner. A fixed window
 * would cut a child off under a slow move that succeeded: a cutover
 * whose adopt is refused gives the note back and asks again, keeping
 * the note out for as long as its own deadline.
 *
 * Written beside and renamed over, readable by this user alone, since
 * it names a process to watch and a reader finding half of it would
 * stop every child in the run.
 */

import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isTickedOwner, type TickedOwner } from "../internal/process-ticks.ts";
import { isRecord } from "../internal/record.ts";
import { noteState } from "../internal/session/move.ts";

/** The file in a run's folder saying who its children answer to. */
export const PARENT_FILE = "parent.json";

/**
 * How long a hand-over waits on a move note that stays out: the
 * deadline of a /host take-up (scripts/host-take-up.ts, 60 minutes),
 * the longest any cutover waits before it gives up.
 */
export const HANDING_MOST_MS = 60 * 60_000;

/**
 * How long a hand-over lasts once its move note has gone: the 120 s a
 * spawn gives the host to open a conversation
 * (extensions/quest-workflow/verbs/spawn-host.ts OPEN_PATIENCE_MS,
 * measured on a loaded builder for E15), which covers plain pi starting
 * on the log after the join's 10 s grace too.
 */
export const HANDING_MARGIN_MS = 120_000;

/** The move a hand-over waits on: whose note, in which folder. */
export interface HandingNote {
	readonly session: string;
	readonly folder: string;
}

/** A fleet let go by its session as it moved, not yet taken up. */
export interface Handing {
	/** When it was let go, as an ISO time. */
	readonly since: string;
	/** The move whose note it waits on. */
	readonly note: HandingNote;
	/** The most it waits on the note, from `since`. */
	readonly mostMs: number;
	/** How long it lasts once the note has gone. */
	readonly marginMs: number;
}

/** What `parent.json` says: handed over, or taken up by an owner. */
export type Parent =
	| { readonly handing: Handing }
	| { readonly owner: TickedOwner };

/** The hand-over a session makes now, waiting on its own move's note. */
export function handingNow(
	note: HandingNote,
	now: number = Date.now(),
): Handing {
	return {
		since: new Date(now).toISOString(),
		note,
		mostMs: HANDING_MOST_MS,
		marginMs: HANDING_MARGIN_MS,
	};
}

/** Where a run's `parent.json` is. */
export function parentPath(runDir: string): string {
	return join(runDir, PARENT_FILE);
}

/**
 * Write a run's `parent.json` whole, readable by this user alone.
 *
 * The run's folder is made if it isn't there yet, since a move can come
 * before any supervisor has started: one starting later must still find
 * the fleet being handed on, or it stops as its parent goes.
 */
export function writeParent(runDir: string, parent: Parent): void {
	const path = parentPath(runDir);
	const staged = `${path}.${randomBytes(8).toString("hex")}`;
	try {
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		writeFileSync(staged, `${JSON.stringify(parent)}\n`, { mode: 0o600 });
		renameSync(staged, path);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
}

/** Take a run's `parent.json` away, once its summary has been said. */
export function removeParent(runDir: string): void {
	rmSync(parentPath(runDir), { force: true });
}

function isHandingNote(value: unknown): value is HandingNote {
	return (
		isRecord(value) &&
		typeof value.session === "string" &&
		value.session !== "" &&
		typeof value.folder === "string" &&
		value.folder.startsWith("/")
	);
}

function isHanding(value: unknown): value is Handing {
	return (
		isRecord(value) &&
		typeof value.since === "string" &&
		!Number.isNaN(Date.parse(value.since)) &&
		isHandingNote(value.note) &&
		typeof value.mostMs === "number" &&
		value.mostMs >= 0 &&
		typeof value.marginMs === "number" &&
		value.marginMs >= 0
	);
}

/**
 * What a run's `parent.json` says, or nothing when there is none or it
 * isn't one, as for a fleet that never moved.
 */
export function readParent(runDir: string): Parent | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(parentPath(runDir), "utf8"));
	} catch {
		// None, as for every fleet that never moved, or not JSON.
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	if (isHanding(value.handing)) return { handing: value.handing };
	if (isTickedOwner(value.owner)) return { owner: value.owner };
	return undefined;
}

/** Whether a hand-over's move note is out now: waiting, or claimed by a cutover. */
export function noteOut(note: HandingNote): boolean {
	return noteState(note.session, note.folder) !== "none";
}

/**
 * Who a run's children answer to, for a reader that wasn't watching
 * the note (the fleet sweep): `handing` while its hand-over may still
 * hold, the owner that took it up, or nothing when it was never handed
 * on or its hand-over has run out, so its record's owner decides.
 */
export function answersTo(
	runDir: string,
	now: number = Date.now(),
	out: (note: HandingNote) => boolean = noteOut,
): "handing" | TickedOwner | undefined {
	const parent = readParent(runDir);
	if (parent === undefined) return undefined;
	if ("owner" in parent) return parent.owner;
	const { handing } = parent;
	// Not knowing when the note went, it is given the whole of both.
	const since = Date.parse(handing.since);
	return out(handing.note) || now - since < handing.mostMs + handing.marginMs
		? "handing"
		: undefined;
}

/**
 * Whether a hand-over still holds at `now`, given when its move's note
 * was last seen out (`noteSeenAt`, nothing when never): while the note
 * is out, up to its most, and for its margin after.
 */
export function stillHanding(
	handing: Handing,
	now: number,
	noteSeenAt: number | undefined,
): boolean {
	const since = Date.parse(handing.since);
	const lastOut = Math.min(
		Math.max(since, noteSeenAt ?? since),
		since + handing.mostMs,
	);
	return now - lastOut < handing.marginMs;
}
