/**
 * Liveness: whether a peer is still on the mesh.
 *
 * Asked of the machine, never of a clock. A presence names the process
 * holding it, and the core's process module says whether that process
 * still runs, comparing its start time and the boot it started in, so
 * a new process wearing an old pid is not mistaken for the peer. That
 * is the one answer the rest of the harness gives too (fleet sweeps,
 * review leases), so the mesh never disagrees with them about who is
 * there. No heartbeat is written on a timer: Skynet's annals found a
 * timer that "turned a timer into pressure to post", and one that died
 * unnoticed for an hour and forty-six minutes.
 *
 * A presence with no process on it (the machine would not say which
 * holds it, or an older harness wrote it) cannot be judged, and is taken
 * as there: telling a sender a peer is gone when it is not costs the
 * message, and the reverse costs a line.
 *
 * Within one boot a presence is judged by its process's start in the
 * kernel's ticks, which nothing moves, rather than by core's start in
 * wall-clock milliseconds, which a suspend moves (process-ticks.ts).
 *
 * A session on another machine is the one exception: its process is
 * that machine's to judge, so the mycelium node carrying it here takes
 * the process out, and is asked instead (node.ts). It is there while the
 * node holds it busy or idle, and gone once the node says it ended or
 * holds it no more. While its machine is out of reach, or no node
 * answers, as while a switch restarts the node, it can't be told, and is
 * taken as there: a link that drops says nothing of whether a session
 * runs, and judging it gone would let go of its leases and holds and tell
 * its senders it ended.
 *
 * A parked session (see parked.ts) is there too while its marker stands,
 * its process gone: it ended only to hold no memory while it waits, and
 * its holder starts it again for what is sent to it.
 *
 * A hosted conversation whose host has gone is resuming, not ended, while
 * its host's roster still holds it and that host is starting again: a
 * host restarting leaves its holds in place, and its next start brings
 * each back, which on 21 November took eight minutes for 116. Judged gone
 * meanwhile, about 60 cells read as ended, which led to questions of who
 * owned their work and nearly to a push onto another cell's branch
 * (IKQ63G). Only that host's own roster holding it says so; one that
 * can't be read leaves it gone, as before. The host is starting again
 * while none runs under its key, or the one running started within
 * {@link RESUME_GRACE_MS} or has it open; past that, a held conversation
 * it never brought back (a start that failed) is gone, not resuming for
 * as long as its hold stands.
 */

import { readFile } from "node:fs/promises";
import type { HostRegistry } from "../core/session/host.ts";
import { hostRegistries } from "../core/session/registry.ts";
import {
	parseRoster,
	type Roster,
	rosterDir,
	rosterPath,
} from "../core/session/roster.ts";
import {
	askedOnceWithTicks,
	processKey,
	type TickFacts,
	tickedStanding,
	tickFacts,
} from "../internal/process-ticks.ts";
import { isParked } from "../internal/session/park.ts";
import { type AskNode, askNode } from "./node.ts";
import type { Presence } from "./presence.ts";

/** Whether a session's parked marker stands. */
export type ParkedAsk = (session: string) => boolean;

/** Whether the host keyed `host` is bringing `conversation` back as it starts again. */
export type HeldAsk = (conversation: string, host: string) => Promise<boolean>;

/**
 * How long a host that started again has to bring back what its roster
 * holds before a conversation it hasn't is no longer taken as resuming.
 * On 21 November one start took eight minutes for 116 conversations.
 */
export const RESUME_GRACE_MS = 20 * 60_000;

/** Where the rosters and host lists are; the machine's unless a test sets them. */
export interface HeldLooking {
	readonly rosters?: string;
	readonly hosts?: string;
	readonly now?: number;
}

/**
 * A {@link HeldAsk} reading each host's roster, and the host lists, once
 * however many presences it is asked about, as one census asks.
 */
export function heldOnce(
	facts: TickFacts = tickFacts,
	looking: HeldLooking = {},
): HeldAsk {
	const now = looking.now ?? Date.now();
	const rosters = new Map<string, Promise<Roster | undefined>>();
	const live = new Map<string, Promise<HostRegistry | undefined>>();
	let lists: readonly HostRegistry[] | undefined;
	const rosterOf = (host: string) => {
		let read = rosters.get(host);
		if (!read) {
			read = rosterAt(host, looking.rosters ?? rosterDir());
			rosters.set(host, read);
		}
		return read;
	};
	const runningHost = (host: string) => {
		let found = live.get(host);
		if (!found) {
			lists ??= looking.hosts
				? hostRegistries(looking.hosts)
				: hostRegistries();
			found = running(
				lists.filter((list) => list.key === host),
				facts,
			);
			live.set(host, found);
		}
		return found;
	};
	return async (conversation, host) => {
		const roster = await rosterOf(host);
		if (!roster?.sessions.some((entry) => entry.sessionId === conversation))
			return false;
		const up = await runningHost(host);
		return (
			up === undefined ||
			now - up.owner.startedAt < RESUME_GRACE_MS ||
			up.sessions.some((one) => one.id === conversation)
		);
	};
}

/** One host key's roster, or nothing when it is missing or can't be read. */
async function rosterAt(
	host: string,
	dir: string,
): Promise<Roster | undefined> {
	try {
		return parseRoster(await readFile(rosterPath(host, dir), "utf8"), host);
	} catch {
		// Missing, unreadable or not a host key: no evidence of a hold.
		return undefined;
	}
}

/** Of a key's host lists, the one whose process runs now, judged by its ticks. */
async function running(
	lists: readonly HostRegistry[],
	facts: TickFacts,
): Promise<HostRegistry | undefined> {
	for (const list of lists) {
		// Asked of the host's process alone: the list says what it holds.
		const { session: _session, ...hostProcess } = list.owner;
		if ((await tickedStanding(hostProcess, facts)) === "running") return list;
	}
	return undefined;
}

/**
 * Whether a peer is there, resuming while its host starts again, gone,
 * or cannot be told.
 */
export type Liveness = "present" | "resuming" | "gone" | "unknown";

/** The peers in a listing, sorted by whether they are still there. */
export interface Census {
	/** Those there, those resuming and those that cannot be told among them. */
	readonly present: readonly Presence[];
	readonly gone: readonly Presence[];
	/** Of those present, the ones a restarting host is bringing back. */
	readonly resuming: readonly Presence[];
}

/** Whether this peer is still on the mesh. */
export async function livenessOf(
	presence: Presence,
	facts: TickFacts = tickFacts,
	node: AskNode = askNode,
	parked: ParkedAsk = isParked,
	held: HeldAsk = heldOnce(facts),
): Promise<Liveness> {
	if (presence.machine !== undefined) {
		const held = await node();
		if (held === undefined) return "unknown";
		const state = held.get(presence.session);
		return state === "busy" || state === "idle"
			? "present"
			: state === "unreachable"
				? "unknown"
				: "gone";
	}
	const owner =
		presence.owner && presence.hosted
			? {
					...presence.owner,
					host: presence.hosted.host,
					session: presence.hosted.conversation,
				}
			: presence.owner;
	if (!owner) return "unknown";
	const standing = await tickedStanding(owner, facts);
	if (standing === "running") return "present";
	if (standing !== "gone") return "unknown";
	if (presence.state === "parked" && parked(presence.session)) return "present";
	if (!presence.hosted) return "gone";
	const { host, conversation } = presence.hosted;
	return (await held(conversation, host)) ? "resuming" : "gone";
}

/**
 * Every peer, sorted into those still there (including those that
 * cannot be told) and those gone, asking the machine once per process.
 *
 * A plain pi process holds one session at a time, so when it moves to
 * another session (a new one, a resumed one), the session it left is
 * gone even though its process runs on: of the presences one process
 * holds, only the one it published last is still there. A process is
 * told by its ticks where its presences carry them: each session start
 * works core's start time out afresh, so after a suspend the sessions
 * one pi held name it by different times. The node is asked once too,
 * and only when a session elsewhere is listed. Hosted presences are
 * judged independently: one process may hold several open conversations.
 */
export async function census(
	everyone: readonly Presence[],
	facts: TickFacts = tickFacts,
	node: AskNode = askNode,
	parked: ParkedAsk = isParked,
	held?: HeldAsk,
): Promise<Census> {
	const once = askedOnceWithTicks(facts);
	const heldHere = held ?? heldOnce(once);
	let asked: ReturnType<AskNode> | undefined;
	const nodeOnce: AskNode = () => {
		asked ??= node();
		return asked;
	};
	const holder = (one: Presence) =>
		one.owner && !one.hosted ? processKey(one.owner) : undefined;
	const latest = new Map<string, string>();
	for (const one of everyone) {
		const key = holder(one);
		if (key && one.at > (latest.get(key) ?? "")) latest.set(key, one.at);
	}
	const left = (one: Presence) => {
		const key = holder(one);
		return key !== undefined && one.at < (latest.get(key) ?? "");
	};
	const judged = await Promise.all(
		everyone.map(
			async (one) =>
				[
					one,
					left(one)
						? "gone"
						: await livenessOf(one, once, nodeOnce, parked, heldHere),
				] as const,
		),
	);
	return {
		present: judged.filter(([, at]) => at !== "gone").map(([one]) => one),
		gone: judged.filter(([, at]) => at === "gone").map(([one]) => one),
		resuming: judged.filter(([, at]) => at === "resuming").map(([one]) => one),
	};
}
