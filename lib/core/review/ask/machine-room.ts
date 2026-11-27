/**
 * Whether the machine has the room to start a council's reviewers.
 *
 * A council starts several pis at once, each holding a pi's worth of
 * memory and busy on the CPU for minutes. Rounds used to start a fixed
 * three minutes apart whatever the machine had to spare, so on 24
 * November one waited about 30 minutes behind ten others on a machine
 * with room for all of them, and on a starved one three minutes was no
 * guard at all. The rule then became memory alone, and on 26 November
 * optimus sat at CPU `some avg60` of 46 to 54 from 17:47 with 24
 * councils' supervisors running at 18:33, since nothing read the CPU.
 * The rule now (A210E4CA, velocity, 26 November) is three readings
 * together: memory `full avg60` under 5, at least 16 GiB of
 * `MemAvailable`, and CPU `some avg60` under 40. On a machine with
 * less than 32 GiB in all, the floor is half of what it has, since 16
 * GiB free could never come there and its rounds would never start.
 *
 * A quiet machine may start rounds closer together. From 05:46Z to
 * 06:16Z on 27 November exactly one round started a minute while CPU
 * `some avg60` read 7 to 20, memory `full avg60` 0.2 to 1.0 and about
 * 23 GB was available, with 84 rounds waiting: the spacing bound, not
 * the bars. So while CPU `some avg60` is under 25, memory `full avg60`
 * under 2 and at least 20 GiB is available (A210E4CA, velocity), the
 * line may use its shortest spacing.
 *
 * CPU alone is a bar a round may pass in time, since optimus sat at
 * CPU `some` 40 to 54 from 17:45 that day and every round held by it
 * alone would have waited for hours (A210E4CA, 26 November). Memory is
 * never passed: a start that runs the machine out of it stalls
 * everything on it.
 */

import { readFile } from "node:fs/promises";
import type { RoomHeld } from "./start-spacing.ts";

/** The kernel's memory pressure, where Linux keeps it. */
export const MEMORY_PRESSURE_FILE = "/proc/pressure/memory";

/** The kernel's CPU pressure, where Linux keeps it. */
export const CPU_PRESSURE_FILE = "/proc/pressure/cpu";

/** The kernel's memory counts, where Linux keeps them. */
export const MEMINFO_FILE = "/proc/meminfo";

/** The memory `full avg60` at and past which a round waits for room. */
export const MEMORY_FULL_AVG60_AT_MOST = 5;

/** The CPU `some avg60` at and past which a round waits for room. */
export const CPU_SOME_AVG60_AT_MOST = 40;

/**
 * The `MemAvailable`, in GiB, under which a round waits for room, on
 * a machine with at least twice that in all.
 */
export const MEM_AVAILABLE_GIB_AT_LEAST = 16;

/** The CPU `some avg60` a quiet machine stays under. */
export const QUIET_CPU_SOME_AVG60_UNDER = 25;

/** The memory `full avg60` a quiet machine stays under. */
export const QUIET_MEMORY_FULL_AVG60_UNDER = 2;

/** The `MemAvailable`, in GiB, a quiet machine has at least. */
export const QUIET_MEM_AVAILABLE_GIB_AT_LEAST = 20;

/** The share of all its memory a smaller machine must have free. */
const SMALL_MACHINE_SHARE = 0.5;

const KIB_PER_GIB = 1024 * 1024;

/** The readings a round's room is judged by, each a file's text. */
export interface MachineReads {
	readonly memoryPressure: () => Promise<string>;
	readonly cpuPressure: () => Promise<string>;
	readonly meminfo: () => Promise<string>;
}

/** Where Linux keeps each reading. */
const LINUX_READS: MachineReads = {
	memoryPressure: () => readFile(MEMORY_PRESSURE_FILE, "utf8"),
	cpuPressure: () => readFile(CPU_PRESSURE_FILE, "utf8"),
	meminfo: () => readFile(MEMINFO_FILE, "utf8"),
};

/**
 * What keeps a round from starting now, said for its answer, or nothing
 * when the machine has room; passable when only CPU is short. Every
 * reading that is short is said. A reading the machine doesn't keep, as
 * on an old kernel, or can't give, says nothing: a round held on a
 * reading that never comes would never start. A Mac keeps none of
 * these, so it reads mac-room.ts instead.
 */
export async function machineShort(
	reads: MachineReads = LINUX_READS,
): Promise<RoomHeld | undefined> {
	const { memory, cpu, available, total } = await readings(reads);
	const floor = Math.min(
		MEM_AVAILABLE_GIB_AT_LEAST,
		(total ?? Number.POSITIVE_INFINITY) * SMALL_MACHINE_SHARE,
	);
	const short = [
		memory !== undefined && memory >= MEMORY_FULL_AVG60_AT_MOST
			? {
					reading: MEMORY_READING,
					said: `memory full avg60 was ${memory}, at or past ${MEMORY_FULL_AVG60_AT_MOST}`,
				}
			: undefined,
		available !== undefined && available < floor
			? {
					reading: AVAILABLE_READING,
					said: `MemAvailable was ${tenthsDown(available)} GiB, under ${tenthsUp(floor)}`,
				}
			: undefined,
		cpu !== undefined && cpu >= CPU_SOME_AVG60_AT_MOST
			? {
					reading: CPU_READING,
					said: `CPU some avg60 was ${cpu}, at or past ${CPU_SOME_AVG60_AT_MOST}`,
				}
			: undefined,
	].filter((each) => each !== undefined);
	if (short.length === 0) return undefined;
	const held = short.map((each) => each.reading);
	return {
		said: short.map((each) => each.said).join("; "),
		readings: held,
		passable: held.every((reading) => reading === CPU_READING),
	};
}

/**
 * Whether the machine is quiet enough for rounds to start at the line's
 * shortest spacing. Only every reading inside its bar says so: a
 * machine that keeps no reading, as a Mac keeps no pressure, is never
 * quiet, and keeps its usual spacing.
 */
export async function machineQuiet(
	reads: MachineReads = LINUX_READS,
): Promise<boolean> {
	const { memory, cpu, available } = await readings(reads);
	return (
		memory !== undefined &&
		memory < QUIET_MEMORY_FULL_AVG60_UNDER &&
		cpu !== undefined &&
		cpu < QUIET_CPU_SOME_AVG60_UNDER &&
		available !== undefined &&
		available >= QUIET_MEM_AVAILABLE_GIB_AT_LEAST
	);
}

/** The readings a round's room is judged by, each nothing where it can't be had. */
interface Readings {
	readonly memory: number | undefined;
	readonly cpu: number | undefined;
	readonly available: number | undefined;
	readonly total: number | undefined;
}

/** Reads memory and CPU pressure and memory counts at once. */
async function readings(reads: MachineReads): Promise<Readings> {
	const [memory, cpu, meminfo] = await Promise.all([
		pressureAvg60(reads.memoryPressure, "full"),
		pressureAvg60(reads.cpuPressure, "some"),
		readOrNothing(reads.meminfo),
	]);
	return {
		memory,
		cpu,
		available: meminfoGib(meminfo, "MemAvailable"),
		total: meminfoGib(meminfo, "MemTotal"),
	};
}

/** The readings a round can be held on, by the names the line shows. */
const MEMORY_READING = "memory full avg60";
const AVAILABLE_READING = "MemAvailable";
const CPU_READING = "CPU some avg60";

/** One pressure line's `avg60`, or nothing where it can't be had. */
async function pressureAvg60(
	read: () => Promise<string>,
	line: "some" | "full",
): Promise<number | undefined> {
	const text = await readOrNothing(read);
	const said = new RegExp(`^${line}\\b.*\\bavg60=(\\d+(?:\\.\\d+)?)`, "m").exec(
		text ?? "",
	)?.[1];
	return said === undefined ? undefined : Number(said);
}

/** One meminfo field in GiB, or nothing where it can't be had. */
function meminfoGib(
	text: string | undefined,
	field: "MemAvailable" | "MemTotal",
): number | undefined {
	const kib = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(
		text ?? "",
	)?.[1];
	return kib === undefined ? undefined : Number(kib) / KIB_PER_GIB;
}

/**
 * An amount said to a tenth, rounded down, so one just under its floor
 * never reads as the floor itself.
 */
function tenthsDown(gib: number): string {
	return (Math.floor(gib * 10) / 10).toFixed(1);
}

/** What multiplying a GiB by ten may add in error, in tenths. */
const FLOAT_SLACK = 1e-9;

/**
 * A floor said to a tenth, rounded up, so a reading under it, rounded
 * down, never reads as the floor. Only a float's own error is let go
 * (`FLOAT_SLACK`, far under a kilobyte), so a floor a kilobyte past a
 * tenth says the tenth above.
 */
function tenthsUp(gib: number): string {
	return (Math.ceil(gib * 10 - FLOAT_SLACK) / 10).toFixed(1);
}

/** A reading's text, or nothing where the machine doesn't keep it. */
async function readOrNothing(
	read: () => Promise<string>,
): Promise<string | undefined> {
	try {
		return await read();
	} catch {
		// No such file, as on a Mac or an old kernel: nothing says short.
		return undefined;
	}
}
