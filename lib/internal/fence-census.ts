/**
 * The fence's census (`pi-fence census`): every live pi session on this
 * machine, judged by what its processes show rather than by what its
 * presence claims, so whether the agent fence holds on every session is
 * a command anyone can run (85PKB2, 62b50ac7 and 55d7c6bc; ISXEG8's
 * condition for Passwords' copy, f00d637d).
 *
 * The fence wraps each command in bubblewrap, never pi itself, so a
 * session's own process shows nothing either way: every pi on optimus
 * had NoNewPrivs 0 and the machine's mount namespace on 16 November,
 * fenced or not. A command shows it. Bubblewrap sets NoNewPrivs and
 * runs what it was given in a mount namespace of its own, so a command
 * is proven fenced when every process at the end of its tree has both,
 * and unfenced when one has neither. A session running no command is
 * judged by what its environment asks, read through the stage's own
 * rules (`fence-stage.ts`), and counted as claimed, not proven.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { FenceKind, Presence } from "../mesh/presence.ts";
import { askedSandbox, inFirstStage } from "./fence-stage.ts";
import { ticksOfStat } from "./process-ticks.ts";
import { SANDBOX_NAMES, STRICT } from "./sandbox.ts";

/** Where the census reads the machine from; tests give their own. */
export interface CensusPlace {
	/** The processes' folder, `/proc` on the machine. */
	readonly proc: string;
	/** The sessions' presences, one file each. */
	readonly presences: readonly Presence[];
	/** The fence's first stage's folder, as `fence-stage.ts` keeps it. */
	readonly stage: string;
	/** Clock ticks per second, which a process's start is counted in. */
	readonly ticksPerSecond: number;
}

/** How a session's commands are fenced, as the census can show it. */
export type Judged = "proven" | "claimed" | "unfenced";

/** One live session, as the census judged it. */
export interface CensusRow {
	readonly session: string;
	readonly address?: string;
	readonly quest?: string;
	readonly title?: string;
	readonly judged: Judged;
	/** Why it was judged so, in a phrase. */
	readonly why: string;
	/** Its presence's claim, where the claim and its environment differ. */
	readonly differs?: string;
}

/** Every live session on the machine, and what was left out. */
export interface Census {
	readonly rows: readonly CensusRow[];
	/** Presences naming no owner, which can't be judged live or not. */
	readonly ownerless: number;
	/**
	 * Whether the processes could be read at all. Without them no session
	 * can be judged, so the census fails rather than finding none.
	 */
	readonly read: boolean;
}

/** One process, as the census reads it from its folder under /proc. */
interface Process {
	readonly pid: number;
	readonly parent: number;
	readonly name: string;
	readonly startTicks?: number;
	/** Its NoNewPrivs flag, or nothing where its status can't be read. */
	readonly noNewPrivs?: boolean;
	/** Its mount namespace, or nothing where the link can't be read. */
	readonly mounts?: string;
	/** Its environment, or nothing where it can't be read. */
	readonly env?: NodeJS.ProcessEnv;
	readonly argv: readonly string[];
}

/**
 * The variable the bash tool's keeper runs with (shell-workflow's
 * command-line.ts), which tells a bash call apart from pi's own
 * helpers, a language server among them, outside the fence by design.
 * The keeper's shell, its forks and the tee keeping its output carry
 * it and run outside every fence; it unsets the variable before it
 * runs the command, so only what lacks it is the command's own.
 */
const COMMAND_VARIABLE = "PI_BASH_KEEP";

/** The program commands start through since #1594, on a session's behalf. */
const SPAWNER = "pi-spawner";

/**
 * How old a process must be before it is judged: bubblewrap sets
 * NoNewPrivs and its mounts only once it has begun, so a census
 * reading it in between would call a fenced command unfenced.
 */
const STARTING_SECONDS = 1;

/** The census of the machine `place` reads. */
export function fenceCensus(place: CensusPlace): Census {
	const boot = readText(join(place.proc, "sys/kernel/random/boot_id"))?.trim();
	const uptime = Number(readText(join(place.proc, "uptime"))?.split(" ")[0]);
	const processes = processesIn(place.proc);
	if (processes === undefined) {
		return { rows: [], ownerless: 0, read: false };
	}
	const children = childrenOf(processes);
	const rows: CensusRow[] = [];
	let ownerless = 0;
	for (const presence of place.presences) {
		const { owner } = presence;
		if (owner === undefined) {
			ownerless += 1;
			continue;
		}
		const running = processes.get(owner.pid);
		// An owner that names no boot or no start is believed live while its
		// pid runs: a session wrongly counted can only make the census fail,
		// and one wrongly left out could let it pass.
		const live =
			running !== undefined &&
			(owner.bootId === undefined || owner.bootId === boot) &&
			(owner.startTicks === undefined ||
				owner.startTicks === running.startTicks);
		if (!live) continue;
		const now = uptime * place.ticksPerSecond;
		rows.push(
			judged(presence, running, {
				commands: commandsOf(presence, running, children),
				children,
				place,
				startingTicks: Number.isFinite(now)
					? now - STARTING_SECONDS * place.ticksPerSecond
					: undefined,
			}),
		);
	}
	return { rows, ownerless, read: true };
}

/** What judging one session needs beside its presence and its process. */
interface Judging {
	readonly commands: readonly Process[];
	readonly children: ReadonlyMap<number, readonly Process[]>;
	readonly place: CensusPlace;
	/** A process begun after this many ticks since boot is still starting. */
	readonly startingTicks?: number;
}

/** One session, judged by its commands, else by what it asks. */
function judged(
	presence: Presence,
	owner: Process,
	{ commands, children, place, startingTicks }: Judging,
): CensusRow {
	const said = {
		session: presence.session,
		...(presence.addresses[0] ? { address: presence.addresses[0] } : {}),
		...(presence.quest ? { quest: presence.quest } : {}),
		...(presence.title ? { title: presence.title } : {}),
	};
	const ends = commands
		.flatMap((command) => endsOf(command, children))
		.filter((end) => ownEnd(end, startingTicks));
	const open = ends.find((end) => end.noNewPrivs === false);
	if (open !== undefined) {
		return {
			...said,
			judged: "unfenced",
			why: `a command runs unfenced: ${open.name}, pid ${open.pid}`,
		};
	}
	if (ends.some((end) => fencedFrom(end, owner))) {
		return { ...said, judged: "proven", why: "its commands run fenced" };
	}
	const claim = presence.fence ?? "none";
	if (owner.env === undefined) {
		return {
			...said,
			judged: "unfenced",
			why: `no command running and no environment to read; its presence says ${claim}`,
		};
	}
	const hosted = presence.owner?.host !== undefined;
	const env: NodeJS.ProcessEnv = {
		...owner.env,
		PI_SESSION_ID: presence.session,
	};
	const asked = askedSandbox(env, SANDBOX_NAMES, (each) =>
		inFirstStage(each, owner.argv, place.stage),
	).name;
	const kind: FenceKind =
		asked === STRICT ? "strict" : asked === undefined ? "none" : "fence";
	const differs =
		claim === kind
			? {}
			: { differs: `its presence says ${claim}, its environment asks ${kind}` };
	const where = hosted ? "its host's environment" : "its environment";
	// An idle session whose next command would run as it is counts as
	// unfenced: what copy guards against is that next command.
	if (kind === "none") {
		const off = env.PI_SANDBOX?.trim() === "off" ? ", PI_SANDBOX=off" : "";
		return {
			...said,
			...differs,
			judged: "unfenced",
			why: `${where} runs commands as they are${off}`,
		};
	}
	return {
		...said,
		...differs,
		judged: "claimed",
		why: `no command running; ${where} asks ${kind}`,
	};
}

/**
 * The commands the bash tool runs for `presence`: those under its pi, or
 * under the spawner its pi starts them through, each its own when its
 * pi hosts no other session or when it names this one.
 */
function commandsOf(
	presence: Presence,
	owner: Process,
	children: ReadonlyMap<number, readonly Process[]>,
): Process[] {
	const under = children.get(owner.pid) ?? [];
	const spawned = under
		.filter((child) => child.name === SPAWNER)
		.flatMap((spawner) => children.get(spawner.pid) ?? []);
	const hosts = presence.owner?.host !== undefined;
	return [...under, ...spawned].filter(
		(child) =>
			child.env?.[COMMAND_VARIABLE] !== undefined &&
			(hosts
				? child.env.PI_SESSION_ID === presence.session
				: (child.env.PI_SESSION_ID ?? presence.session) === presence.session),
	);
}

/**
 * Whether an end of a command's tree is the command's own, not the
 * keeper's, and old enough to judge: one whose environment can't be
 * read can't be told, so it proves nothing either way.
 */
function ownEnd(end: Process, startingTicks: number | undefined): boolean {
	const begun =
		startingTicks !== undefined &&
		end.startTicks !== undefined &&
		end.startTicks > startingTicks;
	return (
		end.env !== undefined && end.env[COMMAND_VARIABLE] === undefined && !begun
	);
}

/** The processes at the ends of a command's tree, the command alone if none. */
function endsOf(
	command: Process,
	children: ReadonlyMap<number, readonly Process[]>,
): Process[] {
	const under = children.get(command.pid) ?? [];
	return under.length === 0
		? [command]
		: under.flatMap((child) => endsOf(child, children));
}

/** Whether a process shows bubblewrap's fence: NoNewPrivs, and mounts of its own. */
function fencedFrom(end: Process, owner: Process): boolean {
	return (
		end.noNewPrivs === true &&
		end.mounts !== undefined &&
		owner.mounts !== undefined &&
		end.mounts !== owner.mounts
	);
}

/**
 * Every process `proc` holds, by pid, one that ends while read left out;
 * nothing where there is no `proc` to read, as on macOS.
 */
function processesIn(proc: string): Map<number, Process> | undefined {
	const processes = new Map<number, Process>();
	let names: string[] = [];
	try {
		names = readdirSync(proc);
	} catch {
		// Said to the caller, which fails rather than finding no session.
		return undefined;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const read = processAt(join(proc, name), Number(name));
		if (read !== undefined) processes.set(read.pid, read);
	}
	return processes;
}

/** One process's folder, read; nothing when it ended before it was read. */
function processAt(folder: string, pid: number): Process | undefined {
	const stat = readText(join(folder, "stat"));
	if (stat === undefined) return undefined;
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const parent = Number(fields[1]);
	const flag = /^NoNewPrivs:\s*(\d)/m.exec(
		readText(join(folder, "status")) ?? "",
	)?.[1];
	const mounts = readLink(join(folder, "ns/mnt"));
	const startTicks = ticksOfStat(stat);
	return {
		pid,
		parent,
		name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
		...(startTicks === undefined ? {} : { startTicks }),
		...(flag === undefined ? {} : { noNewPrivs: flag === "1" }),
		...(mounts === undefined ? {} : { mounts }),
		...environment(readText(join(folder, "environ"))),
		argv: (readText(join(folder, "cmdline")) ?? "")
			.split("\0")
			.filter((word) => word.length > 0),
	};
}

/** Each process's children, by its pid. */
function childrenOf(
	processes: ReadonlyMap<number, Process>,
): Map<number, Process[]> {
	const children = new Map<number, Process[]>();
	for (const each of processes.values()) {
		const siblings = children.get(each.parent) ?? [];
		siblings.push(each);
		children.set(each.parent, siblings);
	}
	return children;
}

/** An environ file's variables, as a process's environment, if it was read. */
function environment(environ: string | undefined): {
	readonly env?: NodeJS.ProcessEnv;
} {
	if (environ === undefined) return {};
	const env: NodeJS.ProcessEnv = {};
	for (const entry of environ.split("\0")) {
		const equals = entry.indexOf("=");
		if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
	}
	return { env };
}

/** A file's text, or nothing when it can't be read. */
function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// Gone, or another account's: the census says what it can't read.
		return undefined;
	}
}

/** Where a link points, or nothing when it can't be read. */
function readLink(path: string): string | undefined {
	try {
		return readlinkSync(path);
	} catch {
		// A process that isn't dumpable keeps its namespaces to itself.
		return undefined;
	}
}

/**
 * The census as a person reads it: the three counts, then a line for
 * each session not proven fenced and each whose claim differs from
 * what its environment asks.
 */
export function censusText(census: Census): string {
	if (!census.read) {
		return "can't read this machine's processes, so no session was judged\n";
	}
	const count = (judged: Judged) =>
		census.rows.filter((row) => row.judged === judged).length;
	const lines = [
		`${census.rows.length} live sessions: ${count("proven")} proven fenced, ${count("claimed")} claimed, ${count("unfenced")} unfenced`,
	];
	for (const judged of ["unfenced", "claimed"] as const) {
		for (const row of census.rows.filter((each) => each.judged === judged)) {
			lines.push(`${judged}  ${rowName(row)}: ${row.why}`);
		}
	}
	for (const row of census.rows) {
		if (row.differs) lines.push(`differs  ${rowName(row)}: ${row.differs}`);
	}
	if (census.ownerless > 0) {
		lines.push(
			`${census.ownerless} presences name no owner, so they aren't counted`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** A session as a line names it: its address, quest and title. */
function rowName(row: CensusRow): string {
	return [row.address ?? row.session, row.quest, row.title]
		.filter((part) => part !== undefined)
		.join("  ");
}

/** Whether every live session's commands are fenced or claim to be. */
export function censusHolds(census: Census): boolean {
	return census.read && census.rows.every((row) => row.judged !== "unfenced");
}
