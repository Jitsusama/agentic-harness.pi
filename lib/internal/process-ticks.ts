/**
 * A process's start as the kernel counts it: clock ticks since boot.
 *
 * Core's process module names a process by its start in wall-clock
 * milliseconds, the boot time `/proc/stat` gives plus these ticks. The
 * kernel moves that boot time whenever the wall clock is corrected,
 * and every suspend nudges it: after 100 suspends on 26 October it had
 * moved four seconds, past core's two-second tolerance, and every peer
 * on the mesh read as a new process wearing an old pid. The ticks
 * never move for a process, so within one boot they name it exactly.
 *
 * Everything that records a process to check on later (a mesh
 * presence, a fleet's owner) records its ticks beside core's owner and
 * is judged here, so no two of them disagree about who is still there.
 * Where the machine keeps no ticks, as on macOS, or a record was
 * written without them, core's account decides as before.
 */

import { readFile } from "node:fs/promises";
import {
	askedOnce,
	type Owner,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
	systemFacts,
} from "@jitsusama/agentic-harness.core/process";

/** A process's start in ticks since boot; nothing when it cannot be read. */
export type StartTicks = (pid: number) => Promise<number | undefined>;

/** What the machine says about its processes, their ticks included where it can. */
export type TickFacts = ProcessFacts & { readonly startTicks?: StartTicks };

/** A process recorded to check on later: core's owner and its start in ticks. */
export type TickedOwner = Owner & { readonly startTicks?: number };

/** Whether a recorded process still runs, as core's `ownerStanding` answers. */
export type Standing = "running" | "gone" | "unknown";

/** Index of the start time (field 22) after the command's closing parenthesis. */
const START_FIELD = 19;

/** A process's start in ticks, read from `/proc/<pid>/stat`. */
export const startTicksFromProc: StartTicks = async (pid) => {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		// The command name sits in parentheses and may hold anything,
		// so the fields are counted from the last closing one.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[START_FIELD]);
		return Number.isSafeInteger(ticks) ? ticks : undefined;
	} catch {
		// No such process, or no /proc, as on macOS: there is nothing to
		// name it by, and the caller falls back on core's account.
		return undefined;
	}
};

/** This machine's account of its processes, ticks included. */
export const tickFacts: TickFacts = {
	...systemFacts,
	startTicks: startTicksFromProc,
};

/** A process as a record names it, with its start in ticks where there are any. */
export async function tickedOwnerNow(
	facts: TickFacts = tickFacts,
	pid: number = process.pid,
): Promise<TickedOwner | undefined> {
	const owner = await ownerNow(facts, pid);
	if (!owner) return undefined;
	const startTicks = await facts.startTicks?.(owner.pid);
	return startTicks === undefined ? owner : { ...owner, startTicks };
}

/**
 * Whether a recorded process still runs: by its ticks when the record
 * names its boot and ticks and the machine can say both, so a suspend
 * never ends it; by core's account otherwise.
 */
export async function tickedStanding(
	owner: TickedOwner,
	facts: TickFacts = tickFacts,
): Promise<Standing> {
	return (await standingByTicks(owner, facts)) ?? ownerStanding(owner, facts);
}

/**
 * The machine's facts, each process asked about once, as core's
 * `askedOnce` does, with the ticks carried through, which it drops.
 */
export function askedOnceWithTicks(facts: TickFacts): TickFacts {
	return {
		...askedOnce(facts),
		...(facts.startTicks ? { startTicks: facts.startTicks } : {}),
	};
}

/**
 * The owner a record names, its ticks kept only when they are a count,
 * so a malformed field is dropped rather than deciding anything.
 */
export function keepTicks(owner: Owner): TickedOwner {
	if (!("startTicks" in owner)) return owner;
	const { startTicks, ...rest } = owner;
	return typeof startTicks === "number" && Number.isSafeInteger(startTicks)
		? { ...rest, startTicks }
		: rest;
}

/**
 * One key per process: its pid and start, in ticks where the record
 * has them, since core's start in milliseconds is worked out afresh
 * each time it is read and moves with the boot clock.
 */
export function processKey(owner: TickedOwner): string {
	return owner.startTicks === undefined
		? `${owner.pid}@${owner.startedAt}`
		: `${owner.pid}@t${owner.startTicks}`;
}

async function standingByTicks(
	owner: TickedOwner,
	facts: TickFacts,
): Promise<Standing | undefined> {
	if (owner.startTicks === undefined || owner.bootId === undefined) {
		return undefined;
	}
	const boot = facts.bootId?.();
	if (boot === undefined || !facts.startTicks) return undefined;
	if (boot !== owner.bootId) return "gone";
	const ticks = await facts.startTicks(owner.pid);
	if (ticks === undefined) return undefined;
	return ticks === owner.startTicks ? "running" : "gone";
}
