/**
 * Whether the machine has the room to start a council's reviewers, and
 * whether a cloud room does, for a round whose reviewers run there.
 *
 * A council starts several pis at once, each holding a pi's worth of
 * memory and busy on the CPU for minutes. Rounds used to start a fixed
 * three minutes apart whatever the machine had to spare, so on 24
 * November one waited about 30 minutes behind ten others on a machine
 * with room for all of them, and on a starved one three minutes was no
 * guard at all. The rule then became memory alone, and on 26 November
 * optimus sat at CPU `some avg60` of 46 to 54 from 17:47 with 24
 * councils' supervisors running at 18:33, since nothing read the CPU.
 * The rule became (A210E4CA, velocity, 26 November) three readings
 * together: memory `full avg60` under 5, at least 16 GiB of
 * `MemAvailable`, and CPU `some avg60` under 40. On a machine with
 * less than 32 GiB in all, the floor is half of what it has, since 16
 * GiB free could never come there and its rounds would never start.
 * On 27 November optimus's io `full avg60` sat at 15 to 23 from 03:05
 * while its CPU fell under 40, so starts would have resumed into a
 * saturated disk that each round's snapshot and greps load further:
 * io `full avg60` under 2 joined the bars (A210E4CA, 3ff42277). At
 * 03:19 the machine's figure read 6.6 while agents.slice read 2.2,
 * app.slice 0.24 and session.slice 0: the rest was a capped background
 * reader stalling alone, which PSI counts as machine-wide `full` while
 * it harms nobody. So where those three slices can be read, each must
 * be under 2 and the machine under 5; where they can't, as on a Mac or
 * a room, the machine's figure alone decides, at 2 (A210E4CA, 1bbafaac).
 *
 * A quiet machine may start rounds closer together. From 05:46Z to
 * 06:16Z on 27 November exactly one round started a minute while CPU
 * `some avg60` read 7 to 20, memory `full avg60` 0.2 to 1.0 and about
 * 23 GB was available, with 84 rounds waiting: the spacing bound, not
 * the bars. So while CPU `some avg60` is under 25, memory `full avg60`
 * under 2 and at least 20 GiB is available (A210E4CA, velocity), the
 * line may use its shortest spacing.
 *
 * A room's bars (A210E4CA, d8565ffd) are its own CPU, memory and io
 * pressure on the same lines, and at least 8 GiB free on its `/`,
 * which can't be cleaned while a room runs, in place of the
 * `MemAvailable` floor; it is quiet on the same readings as here.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The kernel's memory pressure, where Linux keeps it. */
export const MEMORY_PRESSURE_FILE = "/proc/pressure/memory";

/** The kernel's CPU pressure, where Linux keeps it. */
export const CPU_PRESSURE_FILE = "/proc/pressure/cpu";

/** The kernel's io pressure, where Linux keeps it. */
export const IO_PRESSURE_FILE = "/proc/pressure/io";

/** The kernel's memory counts, where Linux keeps them. */
export const MEMINFO_FILE = "/proc/meminfo";

/** The memory `full avg60` at and past which a round waits for room. */
export const MEMORY_FULL_AVG60_AT_MOST = 5;

/** The CPU `some avg60` at and past which a round waits for room. */
export const CPU_SOME_AVG60_AT_MOST = 40;

/**
 * The io `full avg60` at and past which a round waits for room, in each
 * of {@link IO_SLICES}, or the machine's where they can't be read.
 */
export const IO_FULL_AVG60_AT_MOST = 2;

/**
 * The machine's io `full avg60` at and past which a round waits for
 * room, where every one of {@link IO_SLICES} can be read.
 */
export const IO_MACHINE_FULL_AVG60_AT_MOST = 5;

/**
 * The slices of the person's user manager whose io stalls a round
 * would add to: the agents', the apps' and the session's own.
 */
export const IO_SLICES = [
	"agents.slice",
	"app.slice",
	"session.slice",
] as const;

/** Where the user manager keeps one of its slices' io pressure. */
export function sliceIoPressureFile(slice: string): string {
	const uid = process.getuid?.() ?? 0;
	return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/${slice}/io.pressure`;
}

/**
 * The `MemAvailable`, in GiB, under which a round waits for room, on
 * a machine with at least twice that in all.
 */
export const MEM_AVAILABLE_GIB_AT_LEAST = 16;

/** The free space on a room's `/`, in GiB, under which a round waits. */
export const ROOM_ROOT_FREE_GIB_AT_LEAST = 8;

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
	readonly ioPressure: () => Promise<string>;
	readonly sliceIoPressure: (slice: string) => Promise<string>;
	readonly meminfo: () => Promise<string>;
}

/**
 * Where Linux keeps each reading, under `root`: `/` for this machine's
 * own, or a folder laid out the same way standing in for it.
 */
export function readsUnder(root: string): MachineReads {
	const at = (file: string) => readFile(join(root, file), "utf8");
	return {
		memoryPressure: () => at(MEMORY_PRESSURE_FILE),
		cpuPressure: () => at(CPU_PRESSURE_FILE),
		ioPressure: () => at(IO_PRESSURE_FILE),
		sliceIoPressure: (slice) => at(sliceIoPressureFile(slice)),
		meminfo: () => at(MEMINFO_FILE),
	};
}

const LINUX_READS = readsUnder("/");

/**
 * What keeps a round from starting now, said for its answer, or nothing
 * when the machine has room. Every reading that is short is said. A
 * reading the machine doesn't keep, as on a Mac, or can't give, says
 * nothing: a round held on a reading that never comes would never start.
 */
export async function machineShort(
	reads: MachineReads = LINUX_READS,
): Promise<string | undefined> {
	const read = await readings(reads);
	const floor = Math.min(
		MEM_AVAILABLE_GIB_AT_LEAST,
		(read.total ?? Number.POSITIVE_INFINITY) * SMALL_MACHINE_SHARE,
	);
	return saidShort([
		memoryShort(read),
		read.available !== undefined && read.available < floor
			? `MemAvailable was ${tenthsDown(read.available)} GiB, under ${floor.toFixed(1)}`
			: undefined,
		cpuShort(read),
		ioShort(read),
	]);
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
	return quiet(await readings(reads));
}

/**
 * The command a room's readings are asked with, through the node: each
 * pressure file, its memory counts and `/`'s free space, under a
 * heading apiece, so one call answers them all and a file the room
 * lacks leaves only its own heading empty.
 */
export const ROOM_READINGS_COMMAND: readonly string[] = [
	"sh",
	"-c",
	[
		"echo '## cpu'; cat /proc/pressure/cpu",
		"echo '## memory'; cat /proc/pressure/memory",
		"echo '## io'; cat /proc/pressure/io",
		"echo '## meminfo'; cat /proc/meminfo",
		"echo '## root'; df -Pk /",
	].join("; "),
];

/**
 * What keeps a round whose reviewers run on a room from starting now,
 * read from what {@link ROOM_READINGS_COMMAND} printed there, or nothing
 * when the room has room. A reading it didn't print says nothing, as a
 * reading this machine doesn't keep says nothing here.
 */
export function roomShort(said: string): string | undefined {
	const read = roomReadings(said);
	return saidShort([
		memoryShort(read),
		cpuShort(read),
		ioShort(read),
		read.rootFree !== undefined && read.rootFree < ROOM_ROOT_FREE_GIB_AT_LEAST
			? `the room's / had ${tenthsDown(read.rootFree)} GiB free, under ${ROOM_ROOT_FREE_GIB_AT_LEAST.toFixed(1)}`
			: undefined,
	]);
}

/**
 * Whether a room is quiet enough for its rounds to start at the line's
 * shortest spacing, read as {@link roomShort} reads it, on the same
 * readings as {@link machineQuiet}.
 */
export function roomQuiet(said: string): boolean {
	return quiet(roomReadings(said));
}

/** The readings a round's room is judged by, each nothing where it can't be had. */
interface Readings {
	readonly memory: number | undefined;
	readonly cpu: number | undefined;
	readonly io: number | undefined;
	/** Each of {@link IO_SLICES}' io `full avg60`, where all could be read. */
	readonly sliceIo?: ReadonlyMap<string, number>;
	readonly available: number | undefined;
	readonly total: number | undefined;
}

/** Reads every pressure and the memory counts at once. */
async function readings(reads: MachineReads): Promise<Readings> {
	const [memory, cpu, io, meminfo, slices] = await Promise.all([
		readOrNothing(reads.memoryPressure),
		readOrNothing(reads.cpuPressure),
		readOrNothing(reads.ioPressure),
		readOrNothing(reads.meminfo),
		Promise.all(
			IO_SLICES.map(async (slice) => {
				const text = await readOrNothing(() => reads.sliceIoPressure(slice));
				return [slice, avg60(text, "full")] as const;
			}),
		),
	]);
	const sliceIo = new Map<string, number>();
	for (const [slice, full] of slices) {
		if (full !== undefined) sliceIo.set(slice, full);
	}
	return {
		...readingsOf({ memory, cpu, io, meminfo }),
		...(sliceIo.size === IO_SLICES.length ? { sliceIo } : {}),
	};
}

/** A room's readings, and its `/`'s free space, from its printout. */
function roomReadings(
	said: string,
): Readings & { readonly rootFree: number | undefined } {
	const parts = headed(said);
	return {
		...readingsOf({
			memory: parts.get("memory"),
			cpu: parts.get("cpu"),
			io: parts.get("io"),
			meminfo: parts.get("meminfo"),
		}),
		rootFree: rootFreeGib(parts.get("root")),
	};
}

/** The readings in each file's text, which may be missing. */
function readingsOf(texts: {
	readonly memory: string | undefined;
	readonly cpu: string | undefined;
	readonly io: string | undefined;
	readonly meminfo: string | undefined;
}): Readings {
	return {
		memory: avg60(texts.memory, "full"),
		cpu: avg60(texts.cpu, "some"),
		io: avg60(texts.io, "full"),
		available: meminfoGib(texts.meminfo, "MemAvailable"),
		total: meminfoGib(texts.meminfo, "MemTotal"),
	};
}

/** Whether every reading a quiet pace wants is there and inside its bar. */
function quiet({ memory, cpu, available }: Readings): boolean {
	return (
		memory !== undefined &&
		memory < QUIET_MEMORY_FULL_AVG60_UNDER &&
		cpu !== undefined &&
		cpu < QUIET_CPU_SOME_AVG60_UNDER &&
		available !== undefined &&
		available >= QUIET_MEM_AVAILABLE_GIB_AT_LEAST
	);
}

/** Memory pressure past its bar, said, or nothing. */
function memoryShort({ memory }: Readings): string | undefined {
	return memory !== undefined && memory >= MEMORY_FULL_AVG60_AT_MOST
		? `memory full avg60 was ${memory}, at or past ${MEMORY_FULL_AVG60_AT_MOST}`
		: undefined;
}

/** CPU pressure past its bar, said, or nothing. */
function cpuShort({ cpu }: Readings): string | undefined {
	return cpu !== undefined && cpu >= CPU_SOME_AVG60_AT_MOST
		? `CPU some avg60 was ${cpu}, at or past ${CPU_SOME_AVG60_AT_MOST}`
		: undefined;
}

/**
 * io pressure past its bar, said, or nothing: each slice's and the
 * machine's wider one where the slices were read, else the machine's.
 */
function ioShort({ io, sliceIo }: Readings): string | undefined {
	if (sliceIo === undefined) {
		return io !== undefined && io >= IO_FULL_AVG60_AT_MOST
			? `io full avg60 was ${io}, at or past ${IO_FULL_AVG60_AT_MOST}`
			: undefined;
	}
	return saidShort([
		...[...sliceIo]
			.filter(([, full]) => full >= IO_FULL_AVG60_AT_MOST)
			.map(
				([slice, full]) =>
					`io full avg60 in ${slice} was ${full}, at or past ${IO_FULL_AVG60_AT_MOST}`,
			),
		io !== undefined && io >= IO_MACHINE_FULL_AVG60_AT_MOST
			? `io full avg60 was ${io}, at or past ${IO_MACHINE_FULL_AVG60_AT_MOST}`
			: undefined,
	]);
}

/** The shortfalls joined for an answer, or nothing when there are none. */
function saidShort(each: readonly (string | undefined)[]): string | undefined {
	const short = each.filter((said) => said !== undefined);
	return short.length === 0 ? undefined : short.join("; ");
}

/** A printout's parts by heading, each the text under its `## ` line. */
function headed(said: string): Map<string, string> {
	const parts = new Map<string, string>();
	let name: string | undefined;
	for (const line of said.split("\n")) {
		const heading = /^## (\w+)$/.exec(line)?.[1];
		if (heading !== undefined) {
			name = heading;
			parts.set(name, "");
		} else if (name !== undefined) {
			parts.set(name, `${parts.get(name) ?? ""}${line}\n`);
		}
	}
	return parts;
}

/** The free space `df -Pk` printed for its one filesystem, in GiB. */
function rootFreeGib(text: string | undefined): number | undefined {
	const row = text
		?.split("\n")
		.find((line) => /^\S+\s+\d+\s+\d+\s+\d+/.test(line));
	const kib = row?.split(/\s+/)[3];
	return kib === undefined ? undefined : Number(kib) / KIB_PER_GIB;
}

/** One pressure line's `avg60`, or nothing where the text holds none. */
function avg60(
	text: string | undefined,
	line: "some" | "full",
): number | undefined {
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
