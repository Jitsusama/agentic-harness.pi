/**
 * One writer a conversation: a plain pi never opens a log that a live
 * host holds.
 *
 * On 10 November at 23:30 a holder started `pi --session` on a
 * conversation the background host held. Two processes appended to one
 * log, and the plain pi's presence named its own pid over the host's.
 * Pi has no lock on a log, so the check is here: each host keeps a list
 * of what it holds (`hosts/<pid>-<start>.json`, see
 * lib/core/session/registry.ts), and a list whose process still runs,
 * judged by its start ticks so a reused pid never counts, holds what it
 * names. A list left by a host that died holds nothing, so a crashed
 * host never keeps a conversation from plain pi. A move to pi waits for
 * the host's list to drop the conversation before plain pi starts
 * (move.ts), so a move is never refused.
 */

import { hostRegistries } from "../../core/session/registry.ts";
import {
	type Standing,
	type TickedOwner,
	tickedStanding,
} from "../process-ticks.ts";

/**
 * The exit a refused pi ends with, the one a host refused at start ends
 * with, so a holder or unit taking it as final rather than restarting
 * it treats both alike.
 */
export const HELD_ELSEWHERE_EXIT = 78;

/** The live host holding a conversation. */
export interface Holder {
	/** Its key, such as work-background. */
	readonly key: string;
	readonly pid: number;
}

/** Where the lists are and how a process is judged; the machine's unless a test sets them. */
export interface Looking {
	readonly dir?: string;
	readonly standing?: (owner: TickedOwner) => Promise<Standing>;
}

/**
 * The live host holding this conversation, or nothing when no running
 * host lists it.
 */
export async function liveHolder(
	sessionId: string,
	looking: Looking = {},
): Promise<Holder | undefined> {
	const standing = looking.standing ?? ((owner) => tickedStanding(owner));
	const lists = looking.dir ? hostRegistries(looking.dir) : hostRegistries();
	for (const list of lists) {
		if (!list.sessions.some((one) => one.id === sessionId)) continue;
		// Asked of the host's process alone: the list itself says what it holds.
		const { session: _session, ...hostProcess } = list.owner;
		if ((await standing(hostProcess)) === "running")
			return { key: list.key, pid: list.owner.pid };
	}
	return undefined;
}

/** What a refused pi says, naming who holds the conversation. */
export function heldElsewhere(sessionId: string, holder: Holder): string {
	return (
		`Conversation ${sessionId} is open in the ${holder.key} host ` +
		`(pid ${holder.pid}), so plain pi won't open it as a second writer ` +
		"on its log. Reach it through that host, or move it to pi first. " +
		"Nothing was written."
	);
}
