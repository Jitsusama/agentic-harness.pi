/**
 * A hand: a subagent working inside one peer's turn, on the mesh only
 * as that peer's hands.
 *
 * A subagent is a worker with one job, answering to the session that
 * started it. As a peer of its own it would be handed the machine's
 * coordination in the middle of that job and be reached by senders who
 * should reach its parent. Kept off the mesh altogether, though, it
 * could not hear a hold, and the builds and edits it made were nobody's
 * on the board, so another peer was never told they overlapped, and
 * Skynet's parallel cargo builds took its laptop to a load of 192 on
 * 16 cores. So a hand has no address, presence or messages of its own:
 *
 * - what it changes and the heavy work it runs are claimed on the board
 *   as its parent's, in a holding of its own that names the parent;
 * - the holds that reach its parent reach it, before it starts what
 *   they name, and nothing else does;
 * - anything it needs to say goes back to its parent, in its answer.
 *
 * A peer names its session in its environment (`PI_MESH_SESSION`),
 * which every process it starts inherits, a fleet's subagents among
 * them, so a hand knows whose it is without asking anyone.
 */

import { type Holding, isCurrent, type Lease } from "./lease.ts";
import { type Listener, type Message, reaches } from "./message.ts";

/** The environment variable a peer names its session in. */
export const MESH_SESSION_ENV = "PI_MESH_SESSION";

/** A subagent, on the mesh as the hands of the peer that started it. */
export interface Hand {
	/** The session of the peer it works for. */
	readonly of: string;
	/** What it is called on the board, one holding per hand. */
	readonly session: string;
}

/**
 * Whether this pi is a fleet's subagent, which the supervisor marks in
 * the environment it starts the child with.
 */
export function isSubagent(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SUBAGENT_SUPERVISOR === "1" || Boolean(env.SUBAGENT_RUN_ID);
}

/**
 * The hand this pi is, when it is a subagent of a peer on the mesh, or
 * nothing. A subagent started by no peer (by a pi kept off the mesh, or
 * from outside pi) is no peer's hand.
 */
export function handIn(
	env: NodeJS.ProcessEnv = process.env,
	pid: number = process.pid,
): Hand | undefined {
	if (!isSubagent(env)) return undefined;
	const of = env[MESH_SESSION_ENV]?.trim();
	if (!of) return undefined;
	const run = env.SUBAGENT_RUN_ID?.trim();
	const id = env.SUBAGENT_ID?.trim();
	return { of, session: `${of}.hand.${run && id ? `${run}.${id}` : pid}` };
}

/** A hold that stands on the board, as a hand is told of it. */
export interface StandingHold {
	readonly hold: Message;
	readonly lease: Lease;
}

/**
 * The holds standing on the board that reach this listener, oldest
 * first: a hold is a lease its holder keeps until it answers or replaces
 * it, or for two hours at most, and never past the boot it was taken
 * in, when the machine says when it `booted`.
 */
export function holdsReaching(
	board: readonly Holding[],
	read: (id: string) => Message | undefined,
	listener: Listener,
	pid: number,
	now: number,
	booted?: number,
): StandingHold[] {
	return board
		.flatMap((holding) =>
			holding.leases.filter(
				(lease) =>
					lease.kind === "hold" &&
					isCurrent(lease, now) &&
					!(booted !== undefined && Date.parse(lease.since) < booted),
			),
		)
		.flatMap((lease) => {
			const hold = read(lease.subject);
			return hold?.intent === "hold" && reaches(hold, listener, pid)
				? [{ hold, lease }]
				: [];
		})
		.sort((a, b) => (a.hold.id < b.hold.id ? -1 : 1));
}
