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
 * `MemAvailable`, and CPU `some avg60` under 40.
 */

import { readFile } from "node:fs/promises";

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

/** The `MemAvailable`, in GiB, under which a round waits for room. */
export const MEM_AVAILABLE_GIB_AT_LEAST = 16;

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
 * when the machine has room. Every reading that is short is said. A
 * reading the machine doesn't keep, as on a Mac, or can't give, says
 * nothing: a round held on a reading that never comes would never start.
 */
export async function machineShort(
	reads: MachineReads = LINUX_READS,
): Promise<string | undefined> {
	const [memory, cpu, available] = await Promise.all([
		pressureAvg60(reads.memoryPressure, "full"),
		pressureAvg60(reads.cpuPressure, "some"),
		memAvailableGib(reads.meminfo),
	]);
	const short = [
		memory !== undefined && memory >= MEMORY_FULL_AVG60_AT_MOST
			? `memory full avg60 was ${memory}, at or past ${MEMORY_FULL_AVG60_AT_MOST}`
			: undefined,
		available !== undefined && available < MEM_AVAILABLE_GIB_AT_LEAST
			? `MemAvailable was ${available.toFixed(1)} GiB, under ${MEM_AVAILABLE_GIB_AT_LEAST}`
			: undefined,
		cpu !== undefined && cpu >= CPU_SOME_AVG60_AT_MOST
			? `CPU some avg60 was ${cpu}, at or past ${CPU_SOME_AVG60_AT_MOST}`
			: undefined,
	].filter((said) => said !== undefined);
	return short.length === 0 ? undefined : short.join("; ");
}

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

/** `MemAvailable` in GiB, or nothing where it can't be had. */
async function memAvailableGib(
	read: () => Promise<string>,
): Promise<number | undefined> {
	const text = await readOrNothing(read);
	const kib = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text ?? "")?.[1];
	return kib === undefined ? undefined : Number(kib) / KIB_PER_GIB;
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
