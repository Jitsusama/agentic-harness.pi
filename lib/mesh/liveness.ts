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
 */

import { readFileSync } from "node:fs";
import {
	askedOnce,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
	systemFacts,
} from "@jitsusama/agentic-harness.core/process";
import {
	type StartTicks,
	startTicksFromProc,
} from "../internal/process-ticks.ts";
import type { PeerOwner, Presence } from "./presence.ts";

/** What the machine says about its processes, ticks included where it can. */
export type PeerFacts = ProcessFacts & { readonly startTicks?: StartTicks };

/** This machine's account of its processes. */
export const peerFacts: PeerFacts = {
	...systemFacts,
	startTicks: startTicksFromProc,
};

/** This process, as a presence names it, with its start in ticks. */
export async function peerOwnerNow(
	facts: PeerFacts = peerFacts,
): Promise<PeerOwner | undefined> {
	const owner = await ownerNow(facts);
	if (!owner) return undefined;
	const startTicks = await facts.startTicks?.(owner.pid);
	return startTicks === undefined ? owner : { ...owner, startTicks };
}

/**
 * When the machine booted, in milliseconds since the epoch, read from
 * the kernel's `btime`; nothing where the machine will not say. Nothing
 * a peer started before then is under way any more.
 */
export function machineBooted(
	read: () => string = () => readFileSync("/proc/stat", "utf8"),
): number | undefined {
	try {
		const seconds = /^btime (\d+)$/m.exec(read())?.[1];
		return seconds === undefined ? undefined : Number(seconds) * 1000;
	} catch {
		// No /proc, as on macOS: the boot cannot be told, so nothing is
		// judged by it.
		return undefined;
	}
}

/** Whether a peer is there, gone, or cannot be told. */
export type Liveness = "present" | "gone" | "unknown";

/** The peers in a listing, sorted by whether they are still there. */
export interface Census {
	readonly present: readonly Presence[];
	readonly gone: readonly Presence[];
}

/** Whether this peer is still on the mesh. */
export async function livenessOf(
	presence: Presence,
	facts: PeerFacts = peerFacts,
): Promise<Liveness> {
	const owner = presence.owner;
	if (!owner) return "unknown";
	const byTicks = await ticksStanding(owner, facts);
	if (byTicks) return byTicks;
	const standing = await ownerStanding(owner, facts);
	return standing === "running"
		? "present"
		: standing === "gone"
			? "gone"
			: "unknown";
}

/**
 * Whether the presence's process runs, by its start in ticks, when
 * the presence names its boot and ticks and the machine can say both;
 * nothing when it cannot be told that way.
 */
async function ticksStanding(
	owner: PeerOwner,
	facts: PeerFacts,
): Promise<Liveness | undefined> {
	if (owner.startTicks === undefined || owner.bootId === undefined) {
		return undefined;
	}
	const boot = facts.bootId?.();
	if (boot === undefined || !facts.startTicks) return undefined;
	if (boot !== owner.bootId) return "gone";
	const ticks = await facts.startTicks(owner.pid);
	if (ticks === undefined) return undefined;
	return ticks === owner.startTicks ? "present" : "gone";
}

/**
 * Every peer, sorted into those still there (including those that
 * cannot be told) and those gone, asking the machine once per process.
 *
 * One process holds one session at a time, so when a pi moves to
 * another session (a new one, a resumed one), the session it left is
 * gone even though its process runs on: of the presences one process
 * holds, only the one it published last is still there.
 */
export async function census(
	everyone: readonly Presence[],
	facts: PeerFacts = peerFacts,
): Promise<Census> {
	const once: PeerFacts = {
		...askedOnce(facts),
		...(facts.startTicks ? { startTicks: facts.startTicks } : {}),
	};
	const holder = (one: Presence) =>
		one.owner ? `${one.owner.pid}@${one.owner.startedAt}` : undefined;
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
				[one, left(one) ? "gone" : await livenessOf(one, once)] as const,
		),
	);
	return {
		present: judged.filter(([, at]) => at !== "gone").map(([one]) => one),
		gone: judged.filter(([, at]) => at === "gone").map(([one]) => one),
	};
}
