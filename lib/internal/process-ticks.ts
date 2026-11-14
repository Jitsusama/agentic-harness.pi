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

import { readFileSync } from "node:fs";
import { endianness } from "node:os";
import {
	askedOnce,
	type Owner,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
	systemFacts,
} from "../core/process/index.ts";
import { hostedStanding } from "../core/session/registry.ts";
import { isRecord } from "./record.ts";

/** A process's start in ticks since boot; nothing when it cannot be read. */
export type StartTicks = (pid: number) => Promise<number | undefined>;

/** What the machine says about its processes, their ticks included where it can. */
export type TickFacts = ProcessFacts & { readonly startTicks?: StartTicks };

/** A process recorded to check on later: core's owner and its start in ticks. */
export type TickedOwner = Owner & { readonly startTicks?: number };

/**
 * Whether a value read from disk is an owner that can be believed.
 *
 * Checked rather than trusted because of which way a half-written one
 * falls: an owner with a pid and no birthday can't be identified, so
 * it reads as a process that has gone, and the records naming one (a
 * fleet's, its children's parent.json) decide what is stopped or swept.
 */
export function isTickedOwner(value: unknown): value is TickedOwner {
	if (!isRecord(value)) return false;
	const { pid, startedAt, bootId, session, host, startTicks } = value;
	return (
		typeof pid === "number" &&
		// Positive, like the gates that decide whether to signal something:
		// a zero or negative pid names a process group or nothing at all.
		pid > 0 &&
		typeof startedAt === "number" &&
		(bootId === undefined || typeof bootId === "string") &&
		((session === undefined && host === undefined) ||
			(typeof session === "string" &&
				session.length > 0 &&
				typeof host === "string" &&
				host.length > 0)) &&
		// Ticks decide over the start time when they are there, so a
		// malformed count is refused for the same reason a pid is.
		(startTicks === undefined ||
			(typeof startTicks === "number" && Number.isSafeInteger(startTicks)))
	);
}

/** Whether a recorded process still runs, as core's `ownerStanding` answers. */
export type Standing = "running" | "gone" | "unknown";

/** Index of the start time (field 22) after the command's closing parenthesis. */
const START_FIELD = 19;

/**
 * A process's start in ticks, read from `/proc/<pid>/stat`: at once, as
 * core's start time is (lib/core/process/process.ts), since the kernel
 * answers without a disk and a read through libuv's threads wakes one
 * for each step. No such process, or no /proc as on macOS, names none,
 * and the caller falls back on core's account.
 */
export const startTicksFromProc: StartTicks = async (pid) =>
	startTicksFromProcSync(pid);

/**
 * A process's start in ticks, read from `/proc/<pid>/stat` at once, for
 * a caller that answers synchronously, as the quest workflow's session
 * liveness does on pi's input path.
 */
export function startTicksFromProcSync(pid: number): number | undefined {
	try {
		return ticksOfStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		// No such process, or no /proc: as startTicksFromProc.
		return undefined;
	}
}

/**
 * When a process started, in whole seconds since the epoch, read from
 * procfs at once: the boot time `/proc/stat` gives plus the process's
 * start in ticks, whole seconds only, which is the arithmetic `ps` does
 * for `lstart` (procps's pr_lstart). Nothing when either can't be read.
 */
export function startSecondsFromProcSync(pid: number): number | undefined {
	const ticks = startTicksFromProcSync(pid);
	if (ticks === undefined) return undefined;
	let system: string;
	try {
		system = readFileSync("/proc/stat", "utf8");
	} catch {
		// No /proc/stat: no boot time to count from.
		return undefined;
	}
	const boot = Number(/^btime (\d+)$/m.exec(system)?.[1]);
	if (!Number.isSafeInteger(boot)) return undefined;
	return boot + Math.floor(ticks / ticksPerSecond());
}

/** The auxiliary vector's key for the clock ticks per second (AT_CLKTCK). */
const AT_CLKTCK = 17n;
/** One auxiliary vector entry on a 64-bit machine: a key and a value. */
const AUXV_ENTRY_BYTES = 16;
const AUXV_WORD_BYTES = 8;
/** What every Linux on x86 and Arm counts in, where the vector can't say. */
const USER_HZ = 100;

let ticksOnce: number | undefined;

/**
 * Clock ticks per second, as the kernel handed this process at exec in
 * its auxiliary vector, which is where sysconf(_SC_CLK_TCK) reads it:
 * read from a file, since asking getconf would start a child on pi's
 * loop. A 32-bit machine's vector, or none, answers 100.
 */
function ticksPerSecond(): number {
	ticksOnce ??= clockTicksFromAuxv() ?? USER_HZ;
	return ticksOnce;
}

function clockTicksFromAuxv(): number | undefined {
	if (!process.arch.endsWith("64")) return undefined;
	let vector: Buffer;
	try {
		vector = readFileSync("/proc/self/auxv");
	} catch {
		// No procfs: the usual count stands.
		return undefined;
	}
	const little = endianness() === "LE";
	const word = (at: number): bigint =>
		little ? vector.readBigUInt64LE(at) : vector.readBigUInt64BE(at);
	for (let at = 0; at + AUXV_ENTRY_BYTES <= vector.length; at += AUXV_ENTRY_BYTES) {
		if (word(at) !== AT_CLKTCK) continue;
		const ticks = Number(word(at + AUXV_WORD_BYTES));
		return ticks > 0 ? ticks : undefined;
	}
	return undefined;
}

/** The start ticks in one `/proc/<pid>/stat` line. */
function ticksOfStat(stat: string): number | undefined {
	// The command name sits in parentheses and may hold anything, so the
	// fields are counted from the last closing one.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const ticks = Number(fields[START_FIELD]);
	return Number.isSafeInteger(ticks) ? ticks : undefined;
}

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
	const standing = await standingByTicks(owner, facts);
	if (standing === undefined) return ownerStanding(owner, facts);
	return standing === "running" && owner.session !== undefined
		? (facts.sessionStanding?.(owner) ?? hostedStanding(owner))
		: standing;
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
	const process =
		owner.startTicks === undefined
			? `${owner.pid}@${owner.startedAt}`
			: `${owner.pid}@t${owner.startTicks}`;
	return owner.session === undefined
		? process
		: `${process}/${owner.host}/${owner.session}`;
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
