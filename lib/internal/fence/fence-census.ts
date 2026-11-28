/**
 * The fence's census (`pi-fence census`): every live pi session on this
 * machine, judged by what its processes show rather than by what its
 * presence claims, so whether the agent fence holds on every session is
 * a command anyone can run (85PKB2, 62b50ac7 and 55d7c6bc; ISXEG8's
 * condition for Passwords' copy, f00d637d, and its terms, 75d72817).
 *
 * The fence wraps each command in bubblewrap, never pi itself, so a
 * session's own process shows nothing either way: every pi on optimus
 * had NoNewPrivs 0 and the machine's mount namespace on 16 November,
 * fenced or not. A command shows it. Each process at the end of a
 * command's tree is judged, and the command is proven fenced only when
 * each has NoNewPrivs, mounts of its own, and a root where what the
 * fence hides is gone: no private key in `~/.ssh`, no session bus, no
 * token in gh's hosts file and nothing in what `fence-hidden.json`
 * empties. The marks alone prove nothing, since any command can give
 * them to itself (`unshare -rm setpriv --no-new-privs`). An end shown
 * anything less counts unfenced.
 *
 * Only the keeper's own shell and the tee keeping its output are left
 * out, told by what they run (the store's bash running the keeping stub
 * for a call kept where the bash tool keeps them, and the store's tee
 * writing that call's output), never by what their environment says,
 * which a command can set itself. A fork of the keeper is judged, so a
 * command run in the keeper's subshell as builtins is seen.
 *
 * A session running no command is judged by what its environment asks,
 * read through the stage's own rules (`fence-stage.ts`), with the fence
 * lifted as its pi lifts it from all but subagents (`fence-lifted.ts`),
 * and counted as claimed, not proven. A claim says what the next command would ask
 * for, never that the fence lays, so the census keeps when it last saw
 * each session's commands fenced, and a claimed session holds only when
 * that was within the last day. A process that leaves its command's
 * tree (a `setsid` reparented to the person's service manager) isn't
 * seen; that rule is what bounds it.
 *
 * Each session also says whether the fence's first stage takes it, and
 * why not where it doesn't, so a census narrowed to the stage
 * (`pi-fence census --stage`) can judge a stage that by design leaves
 * out the pis Joel sits at: a terminal's and the attended host's. One
 * left out as neither is a pi the stage should have taken, so it fails
 * that census rather than hide in its count (ISXEG8, 27 November).
 */

import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { FenceKind, Presence } from "../../mesh/presence.ts";
import { count, verb } from "../../ui/count.ts";
import { ticksOfStat } from "../process-ticks.ts";
import { SANDBOX_NAMES, STRICT } from "../sandbox/sandbox.ts";
import { KEEP_VARIABLE, KEEPING_STUB } from "../shell/kept.ts";
import { GCLOUD_KEY, holdsStandIn } from "./fence-gcloud-ssh.ts";
import { FENCE_HIDDEN } from "./fence-hidden.ts";
import { liftFence } from "./fence-lifted.ts";
import { askedSandbox, type LeftOut, leftOutOfStage } from "./fence-stage.ts";

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
	/** The person's home folder, as every process names it. */
	readonly home: string;
	/** The person's runtime folder, where their session bus is. */
	readonly runtimeDir?: string;
	/** Where the bash tool keeps its calls (`keptFolder`). */
	readonly kept: string;
	/** When an earlier census last saw each session proven, in ms. */
	readonly sightings: Readonly<Record<string, number>>;
	/** When this census runs, in ms. */
	readonly now: number;
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
	/**
	 * Why the fence's first stage leaves it out (`leftOutOfStage`), or
	 * nothing where the stage takes it or its environment asks a fence of
	 * its own; nothing too where its environment can't be read, so a
	 * census of the stage judges one too many rather than one too few.
	 */
	readonly outside?: LeftOut;
	/** The pid of the process holding it: its pi, or its host's. */
	readonly pid: number;
	/** What that process runs, by the name /proc gives it. */
	readonly command: string;
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
	/**
	 * When each session was last seen proven, this census's own sightings
	 * added and those past a day let go, for the caller to keep.
	 */
	readonly sightings: Readonly<Record<string, number>>;
	/** When it ran, in ms. */
	readonly now: number;
	/**
	 * Once narrowed to the stage (`stageCensus`), the live sessions it
	 * leaves out, unjudged, each saying why.
	 */
	readonly unstaged?: readonly CensusRow[];
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
	/** The program it runs, or nothing where the link can't be read. */
	readonly exe?: string;
	/** Its environment, or nothing where it can't be read. */
	readonly env?: NodeJS.ProcessEnv;
	readonly argv: readonly string[];
}

/** The program commands start through since #1594, on a session's behalf. */
const SPAWNER = "pi-spawner";

/** Where the store keeps every program the keeper runs. */
const STORE = "/nix/store/";

/**
 * How old a process must be before it is judged: bubblewrap sets
 * NoNewPrivs and its mounts only once it has begun, so a census
 * reading it in between would call a fenced command unfenced. The
 * keeper's watchdog, a fork living at most a second once a command
 * ends, is never this old.
 */
const STARTING_SECONDS = 1;

/** How long a sighting of a session's commands fenced holds its claim. */
export const SIGHTING_LASTS_MS = 24 * 60 * 60 * 1000;

/** An hour, which a sighting's age is said in. */
const HOUR_MS = 60 * 60 * 1000;

/** The census of the machine `place` reads. */
export function fenceCensus(place: CensusPlace): Census {
	const kept = keptSightings(place);
	const boot = readText(join(place.proc, "sys/kernel/random/boot_id"))?.trim();
	const uptime = Number(readText(join(place.proc, "uptime"))?.split(" ")[0]);
	const processes = processesIn(place.proc);
	if (processes === undefined) {
		return {
			rows: [],
			ownerless: 0,
			read: false,
			sightings: kept,
			now: place.now,
		};
	}
	const children = childrenOf(processes);
	const rows: CensusRow[] = [];
	const sightings: Record<string, number> = { ...kept };
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
		const row = judged(presence, running, {
			commands: commandsOf(presence, running, children),
			children,
			place,
			startingTicks: Number.isFinite(now)
				? now - STARTING_SECONDS * place.ticksPerSecond
				: undefined,
		});
		if (row.judged === "proven") sightings[presence.session] = place.now;
		rows.push(row);
	}
	return { rows, ownerless, read: true, sightings, now: place.now };
}

/** The sightings an earlier census kept that still hold. */
function keptSightings(place: CensusPlace): Record<string, number> {
	return Object.fromEntries(
		Object.entries(place.sightings).filter(
			([, at]) =>
				Number.isFinite(at) &&
				place.now - at <= SIGHTING_LASTS_MS &&
				at <= place.now,
		),
	);
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
	const asks =
		owner.env === undefined
			? undefined
			: askedOf(presence, owner.env, owner.argv, place);
	const said = {
		session: presence.session,
		...(presence.addresses[0] ? { address: presence.addresses[0] } : {}),
		...(presence.quest ? { quest: presence.quest } : {}),
		...(presence.title ? { title: presence.title } : {}),
		...(asks?.outside === undefined ? {} : { outside: asks.outside }),
		pid: owner.pid,
		command: owner.name,
	};
	const ends = commands
		.flatMap((command) => endsOf(command, children, place))
		.filter((end) => oldEnough(end, startingTicks));
	for (const end of ends) {
		const unproven = notProven(end, owner, place);
		if (unproven !== undefined) {
			return { ...said, judged: "unfenced", why: unproven };
		}
	}
	if (ends.length > 0) {
		return { ...said, judged: "proven", why: "its commands run fenced" };
	}
	const claim = presence.fence ?? "none";
	if (asks === undefined) {
		return {
			...said,
			judged: "unfenced",
			why: `no command running and no environment to read; its presence says ${claim}`,
		};
	}
	const { env, kind, lifted } = asks;
	const hosted = presence.owner?.host !== undefined;
	const differs =
		claim === kind
			? {}
			: { differs: `its presence says ${claim}, its environment asks ${kind}` };
	const where = hosted ? "its host's environment" : "its environment";
	// An idle session whose next command would run as it is counts as
	// unfenced: what copy guards against is that next command.
	if (kind === "none") {
		const off = lifted
			? ", PI_SANDBOX=fence lifted"
			: env.PI_SANDBOX?.trim() === "off"
				? ", PI_SANDBOX=off"
				: "";
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

/** What a session's environment asks, read as its pi reads it. */
interface Asks {
	/** Its environment, as its pi sees it once it lifted the fence. */
	readonly env: NodeJS.ProcessEnv;
	readonly kind: FenceKind;
	/** Whether its pi lifted `PI_SANDBOX=fence` from itself. */
	readonly lifted: boolean;
	/**
	 * Why the stage leaves it out, or nothing where it takes it or it
	 * asks a fence of its own.
	 */
	readonly outside?: LeftOut;
}

/** What `presence`'s environment `started`, as its pi started, asks. */
function askedOf(
	presence: Presence,
	started: NodeJS.ProcessEnv,
	argv: readonly string[],
	place: CensusPlace,
): Asks {
	// A hosted conversation's key is in its own environment, never its
	// host process's, so it is said back from the presence for the stage.
	const hostKey = presence.owner?.host;
	const env: NodeJS.ProcessEnv = {
		...started,
		PI_SESSION_ID: presence.session,
		...(hostKey === undefined ? {} : { PI_HOST_KEY: hostKey }),
	};
	// /proc shows the environment the pi started with, before it lifted
	// the fence from itself (fence-lifted.ts), so the census lifts it too.
	const lifted = liftFence(env);
	const outside = leftOutOfStage(env, argv, place.stage);
	const asked = askedSandbox(
		env,
		SANDBOX_NAMES,
		() => outside === undefined,
	).name;
	const kind: FenceKind =
		asked === STRICT ? "strict" : asked === undefined ? "none" : "fence";
	// A session the stage takes is staged even set off, so its way back
	// shows as unfenced; one outside asking a fence is held to it.
	return {
		env,
		kind,
		lifted,
		...(outside === undefined || kind !== "none" ? {} : { outside }),
	};
}

/**
 * The bash calls `presence`'s pi runs: those under it, or under the
 * spawner it starts them through, that carry the keeper's variable, which
 * tells them from pi's own helpers: a language server among them, which
 * runs in the session's fence but is no command of it. Each is its own
 * when its pi hosts no other session or when it names this one.
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
			child.env?.[KEEP_VARIABLE] !== undefined &&
			(hosts
				? child.env.PI_SESSION_ID === presence.session
				: (child.env.PI_SESSION_ID ?? presence.session) === presence.session),
	);
}

/**
 * The processes at the ends of a command's tree that are the command's
 * own: every leaf but the keeper's shell, when it runs nothing, and the
 * tee keeping its output, each told by what it runs.
 */
function endsOf(
	command: Process,
	children: ReadonlyMap<number, readonly Process[]>,
	place: CensusPlace,
): Process[] {
	const keep = keeperOf(command, place.kept);
	const leaves = (each: Process): Process[] => {
		const under = children.get(each.pid) ?? [];
		return under.length === 0 ? [each] : under.flatMap(leaves);
	};
	return leaves(command).filter(
		(end) =>
			keep === undefined || (end !== command && !teeOf(end, command, keep)),
	);
}

/**
 * The call a command's root keeps, when it is the keeper itself: the
 * store's bash, running the keeping stub, for a call kept where the bash
 * tool keeps them. Anything else, whatever its environment, is judged.
 */
function keeperOf(command: Process, kept: string): string | undefined {
	const keep = command.env?.[KEEP_VARIABLE];
	const [, flag, stub, ...rest] = command.argv;
	const ran =
		command.exe?.startsWith(STORE) === true &&
		basename(command.exe) === "bash" &&
		flag === "-c" &&
		stub === KEEPING_STUB &&
		rest.length === 0;
	return ran && keep?.startsWith(`${kept}/`) === true ? keep : undefined;
}

/**
 * The programs a tee runs as: tee itself, or coreutils whole, which runs
 * as the program its first word names, as optimus's tee does.
 */
const TEE_PROGRAMS: ReadonlySet<string> = new Set(["tee", "coreutils"]);

/** Whether `end` is the store's tee writing the keeper's call's output. */
function teeOf(end: Process, keeper: Process, keep: string): boolean {
	const [program, ...words] = end.argv;
	return (
		end.parent === keeper.pid &&
		end.exe?.startsWith(STORE) === true &&
		TEE_PROGRAMS.has(basename(end.exe)) &&
		program !== undefined &&
		basename(program) === "tee" &&
		words.join("\0") === ["-p", "-a", `${keep}.out`].join("\0")
	);
}

/** Whether a process began long enough ago to be judged. */
function oldEnough(end: Process, startingTicks: number | undefined): boolean {
	return !(
		startingTicks !== undefined &&
		end.startTicks !== undefined &&
		end.startTicks > startingTicks
	);
}

/**
 * Why an end of a command isn't proven fenced, or nothing when it is:
 * NoNewPrivs, mounts of its own, and nothing the fence hides in sight.
 */
function notProven(
	end: Process,
	owner: Process,
	place: CensusPlace,
): string | undefined {
	const named = `${end.name}, pid ${end.pid}`;
	if (end.noNewPrivs === false) return `a command runs unfenced: ${named}`;
	const unshown = (why: string) =>
		`a command can't be shown fenced: ${named}, ${why}`;
	if (end.noNewPrivs === undefined) {
		return unshown("its NoNewPrivs can't be read");
	}
	if (
		end.mounts === undefined ||
		owner.mounts === undefined ||
		end.mounts === owner.mounts
	) {
		return unshown("it shares the machine's mounts");
	}
	const root = join(place.proc, String(end.pid), "root");
	if (entriesOf(root) === undefined) return unshown("its root can't be read");
	const seen = hiddenSeen(root, place);
	return seen === undefined
		? undefined
		: `a command sees what the fence hides: ${named}, reads ${seen}`;
}

/**
 * The first thing the fence hides that a process with root `root` can
 * see, as its own path, or nothing: a file in `~/.ssh` other than what
 * names hosts and keys and the fence's stand-in for gcloud's key
 * (`fence-gcloud-ssh.ts`), the session's bus, a token in gh's hosts file,
 * or anything in what `fence-hidden.json` empties.
 */
function hiddenSeen(root: string, place: CensusPlace): string | undefined {
	const ssh = join(place.home, ".ssh");
	const standIn = (entry: string): boolean =>
		entry === GCLOUD_KEY && holdsStandIn(join(root, ssh, entry));
	const sshSeen = (entriesOf(join(root, ssh)) ?? []).find(
		(entry) => !(FENCE_HIDDEN.sshKept.test(entry) || standIn(entry)),
	);
	if (sshSeen !== undefined) return join(ssh, sshSeen);
	if (place.runtimeDir !== undefined) {
		const bus = join(place.runtimeDir, "bus");
		if (kindOf(join(root, bus)) !== undefined) return bus;
	}
	const hosts = join(place.home, ".config/gh/hosts.yml");
	if (/oauth_token/.test(readText(join(root, hosts)) ?? "")) return hosts;
	for (const hidden of FENCE_HIDDEN.home) {
		const path = join(place.home, hidden);
		if (hidden.endsWith("/")) {
			const inside = entriesOf(join(root, path))?.[0];
			if (inside !== undefined) return join(path, inside);
		} else if (kindOf(join(root, path)) === "full") {
			return path;
		}
	}
	return undefined;
}

/** A folder's entries, sorted, or nothing when it can't be read. */
function entriesOf(folder: string): string[] | undefined {
	try {
		return readdirSync(folder).sort();
	} catch {
		// Absent, or not ours to read: the caller says which matters.
		return undefined;
	}
}

/**
 * What is at `path`: a file holding something, or anything else there
 * (an empty file, the null device the fence binds over a file, a
 * folder); nothing when nothing is.
 */
function kindOf(path: string): "full" | "there" | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.size > 0 ? "full" : "there";
	} catch {
		// Nothing there, which is what the fence leaves.
		return undefined;
	}
}

/**
 * Every process `proc` holds, by pid in order, one that ends while read
 * left out; nothing where there is no `proc` to read, as on macOS.
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
	const pids = names
		.filter((name) => /^\d+$/.test(name))
		.map(Number)
		.sort((a, b) => a - b);
	for (const pid of pids) {
		const read = processAt(join(proc, String(pid)), pid);
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
	const exe = readLink(join(folder, "exe"));
	const startTicks = ticksOfStat(stat);
	return {
		pid,
		parent,
		name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
		...(startTicks === undefined ? {} : { startTicks }),
		...(flag === undefined ? {} : { noNewPrivs: flag === "1" }),
		...(mounts === undefined ? {} : { mounts }),
		...(exe === undefined ? {} : { exe }),
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
 * The census as a person reads it: the three counts, narrowed to the
 * stage the count it left out by why, then a line for each session left
 * out as neither a terminal's nor the attended host's, each not proven
 * fenced, a claimed one saying when it was last seen fenced, and each
 * whose claim differs from what its environment asks.
 */
export function censusText(census: Census): string {
	if (!census.read) {
		return "can't read this machine's processes, so no session was judged\n";
	}
	const judgedAs = (judged: Judged) =>
		census.rows.filter((row) => row.judged === judged).length;
	const where = census.unstaged === undefined ? "" : " in the stage";
	const lines = [
		`${count(census.rows.length, "live session")}${where}: ${judgedAs("proven")} proven fenced, ${judgedAs("claimed")} claimed, ${judgedAs("unfenced")} unfenced`,
	];
	if (census.unstaged !== undefined) {
		lines.push(unstagedLine(census.unstaged));
	}
	for (const row of census.unstaged ?? []) {
		if (row.outside !== "neither") continue;
		lines.push(
			`neither  ${rowName(row)}: outside the stage, though neither a terminal's nor the attended host's, so the stage should have taken it: ${row.command}, pid ${row.pid}`,
		);
	}
	for (const row of census.rows.filter((each) => each.judged === "unfenced")) {
		lines.push(`unfenced  ${rowName(row)}: ${row.why}`);
	}
	for (const row of census.rows.filter((each) => each.judged === "claimed")) {
		lines.push(`claimed  ${rowName(row)}: ${row.why}; ${seenAgo(census, row)}`);
	}
	for (const row of census.rows) {
		if (row.differs) lines.push(`differs  ${rowName(row)}: ${row.differs}`);
	}
	if (census.ownerless > 0) {
		const n = census.ownerless;
		lines.push(
			`${count(n, "presence")} ${verb(n, "names", "name")} no owner, so ${verb(n, "it isn't", "they aren't")} counted`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** How each reason the stage leaves a session out is said, in order. */
const LEFT_OUT_SAID: readonly (readonly [LeftOut, string])[] = [
	["terminal", "a terminal's"],
	["attended", "the attended host's"],
	["later", "a later step's"],
	["neither", "neither"],
];

/** The count of the sessions the stage leaves out, split by why. */
function unstagedLine(unstaged: readonly CensusRow[]): string {
	const said = `${unstaged.length} outside the stage, left unjudged`;
	const split = LEFT_OUT_SAID.flatMap(([why, words]) => {
		const n = unstaged.filter((row) => row.outside === why).length;
		return n === 0 ? [] : [`${n} ${words}`];
	});
	return split.length === 0 ? said : `${said}: ${split.join(", ")}`;
}

/** When a census last saw a claimed session's commands fenced. */
function seenAgo(census: Census, row: CensusRow): string {
	const at = census.sightings[row.session];
	if (at === undefined) return "not seen fenced in the last 24 hours";
	const hours = Math.floor((census.now - at) / HOUR_MS);
	return hours === 0
		? "seen fenced within the hour"
		: `seen fenced ${count(hours, "hour")} ago`;
}

/** A session as a line names it: its address, quest and title. */
function rowName(row: CensusRow): string {
	return [row.address ?? row.session, row.quest, row.title]
		.filter((part) => part !== undefined)
		.join("  ");
}

/**
 * The census narrowed to the sessions the fence's first stage takes,
 * or whose environment asks a fence of its own, keeping those it leaves
 * out apart, each saying why: the stage takes no terminal's pi or the
 * attended host's, by design, so a census of every session can't judge
 * it.
 */
export function stageCensus(census: Census): Census {
	const rows = census.rows.filter((row) => row.outside === undefined);
	const unstaged = census.rows.filter((row) => row.outside !== undefined);
	return { ...census, rows, unstaged };
}

/**
 * Whether the census shows the fence on every live session: at least one
 * was found, none runs unfenced, each claimed one was seen fenced in the
 * last day, and, narrowed to the stage, it left none out as neither a
 * terminal's nor the attended host's.
 */
export function censusHolds(census: Census): boolean {
	return (
		census.read &&
		census.rows.length > 0 &&
		(census.unstaged ?? []).every((row) => row.outside !== "neither") &&
		census.rows.every(
			(row) =>
				row.judged === "proven" ||
				(row.judged === "claimed" &&
					census.sightings[row.session] !== undefined),
		)
	);
}
