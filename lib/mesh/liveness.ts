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
 */

import { readFileSync } from "node:fs";
import {
	askedOnce,
	ownerStanding,
	type ProcessFacts,
	systemFacts,
} from "@jitsusama/agentic-harness.core/process";
import type { Presence } from "./presence.ts";

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
	facts: ProcessFacts = systemFacts,
): Promise<Liveness> {
	if (!presence.owner) return "unknown";
	const standing = await ownerStanding(presence.owner, facts);
	return standing === "running"
		? "present"
		: standing === "gone"
			? "gone"
			: "unknown";
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
	facts: ProcessFacts = systemFacts,
): Promise<Census> {
	const once = askedOnce(facts);
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
