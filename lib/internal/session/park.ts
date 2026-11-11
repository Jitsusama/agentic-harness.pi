/**
 * Parking a session: ending an idle pi so it holds no memory while it
 * waits, and starting it again when something needs it.
 *
 * On 6 November 76 sessions held 45 GB of a 62 GB machine, and the 27
 * idle over an hour held 14.3 GB of it, while a session with a small
 * log still held 469 MB: most of what an idle session holds is pi and
 * its extensions, which no rollover gives back. Only ending the process
 * does.
 *
 * A session parks once it has been idle past the time the switch sets,
 * with nothing of its own still out: no run, no background job, no
 * prompt open, nothing typed and unsent, and nothing another extension
 * says it holds (asked on the bus as {@link PARK_ASK}). It writes a
 * marker naming its log, says so on the bus ({@link PARKING}), so the
 * mesh's presence says `parked`, and exits with {@link PARKED_EXIT}.
 *
 * Waking is the holder's: mycelium's, which keeps each window's pty and
 * its `pi --session` command, and tells the pi it holds where its wake
 * file is ({@link WAKE_ENV}). On that exit code it keeps the window and
 * starts the session again in it when anything is written to that file
 * or a key is typed in the window, and deletes the file itself. It
 * starts it again with the command the pi named as it parked
 * ({@link AGAIN_ENV}), since the launcher starts a session as a bare
 * `pi`, or with a first prompt, which would otherwise wake as a new
 * conversation or send that prompt again. The
 * marker names the file as `wake`, and a sender writes to it when its
 * message would give a parked peer a turn (see mesh/parked.ts); the
 * mesh keeps unread messages on disk until a peer's next start, so
 * nothing sent to a parked peer is lost.
 *
 * A rollover can also have a session start again at once on its fresh
 * log ({@link RESTART_ASK}): the same exit, holding to the same rules
 * but for the idle time, with the command naming the fresh log and the
 * wake written before it goes, so the holder starts it again as soon as
 * it has. It writes no marker, since it is never parked for long.
 *
 * Off unless the switch, or `PI_PARK`, turns it on, and only where a
 * holder said where its wake file is, since a session that parks where
 * no holder will wake it is a session ended.
 *
 * A park lasts only as long as the boot it was written in. The holder
 * and its wake file go with the machine, so a marker from before the
 * machine booted names a session nobody will wake: after the 19:15
 * reboot on 7 November all 11 markers still stood, and the mesh took
 * their sessions for parked and wrote wakes no holder read. Such a
 * marker counts as no park, and the next session to start clears it.
 */

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Booted, machineBooted } from "../booted.ts";
import { stateDir } from "../paths.ts";
import { isRecord } from "../record.ts";
import { SANDBOX_VARIABLE } from "../sandbox.ts";
import { SPAWNER_VARIABLE } from "../shell/spawner-variable.ts";
import { writeWhole } from "../write-whole.ts";
import { type Holding, whatHolds } from "./free.ts";

/**
 * The variable that turns parking on (`on`) or keeps it off whatever the
 * switch says (`off`), read at start.
 */
export const PARK_ENV = "PI_PARK";

/**
 * Where the holder keeping this pi watches for its wake, an absolute
 * path its holder sets; unset, nothing would wake it, so it never parks.
 */
export const WAKE_ENV = "MYCELIUM_WAKE";

/**
 * Where the holder takes the command it wakes this pi with, a JSON list
 * of a program and its arguments written as it parks. A holder that
 * sets none runs its command again, so a session parks under it only
 * when that command already opens this session.
 */
export const AGAIN_ENV = "MYCELIUM_AGAIN";

/**
 * The command that starts a session again from its log, giving it again
 * the flags it was started with that say which model it runs
 * ({@link CARRIED_FLAGS}).
 */
export function restartCommand(
	sessionFile: string,
	args: readonly string[] = [],
): string[] {
	return ["pi", "--session", sessionFile, ...carriedFlags(args)];
}

/**
 * The variables, as a session was started with them, that say how it
 * runs its commands: in the agent fence and through the spawner. A
 * holder runs the command it is given in its own environment, so on 11
 * November a session started fenced came back from its park unfenced.
 */
const CARRIED_VARIABLES = [SANDBOX_VARIABLE, SPAWNER_VARIABLE];

/**
 * The command a holder starts the session again with: the
 * {@link restartCommand}, behind `env` naming each of the
 * {@link CARRIED_VARIABLES} this pi was started with.
 */
export function holderCommand(
	sessionFile: string,
	args: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const carried = CARRIED_VARIABLES.flatMap((name) => {
		const value = env[name];
		return value === undefined || value === "" ? [] : [`${name}=${value}`];
	});
	const command = restartCommand(sessionFile, args);
	return carried.length === 0 ? command : ["env", ...carried, ...command];
}

/** The flags that name the session pi opens. */
const SESSION_FLAGS = new Set(["--session", "--session-id"]);

/**
 * The flags, each with its value, that a restart gives pi again, since
 * they say which model it runs, which it cycles through and how hard it
 * thinks. On 10 November a
 * restart of old idle sessions was refused for most of them, because
 * their holders had started them with `--model`.
 */
const CARRIED_FLAGS = new Set([
	"--model",
	"--models",
	"--provider",
	"--thinking",
]);

/** The {@link CARRIED_FLAGS} in pi's arguments, as written, up to `--`. */
function carriedFlags(args: readonly string[]): string[] {
	const carried: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--") break;
		const [flag = "", inline] = arg.split(/[=](.*)/s, 2);
		if (!CARRIED_FLAGS.has(flag)) continue;
		if (inline !== undefined) carried.push(arg);
		else if (args[i + 1] !== undefined) {
			carried.push(arg, args[i + 1] ?? "");
			i += 1;
		}
	}
	return carried;
}

/**
 * Whether pi's arguments open this session, by its id or its log, as
 * `--session` or `--session-id`, and do nothing else: started again as
 * it was, a pi given a prompt besides would send that prompt again.
 */
export function opensOnlyItself(
	args: readonly string[],
	session: string,
	sessionFile: string,
): boolean {
	const [first = "", second, ...rest] = args;
	const [flag = "", inline] = first.split(/[=](.*)/s, 2);
	if (!SESSION_FLAGS.has(flag)) return false;
	const value = inline ?? second;
	const extra = inline === undefined ? rest : args.slice(1);
	return extra.length === 0 && (value === session || value === sessionFile);
}

/**
 * The flags in pi's arguments that {@link restartCommand} would not
 * give it again, such as an `-e` extension. A prompt is not among them,
 * since the log holds it, nor is anything after `--`.
 */
export function flagsLost(args: readonly string[]): string[] {
	const lost: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--") break;
		if (!arg.startsWith("-") || arg === "-") continue;
		const [flag = "", inline] = arg.split(/[=](.*)/s, 2);
		const valued = SESSION_FLAGS.has(flag) || CARRIED_FLAGS.has(flag);
		if (!valued) lost.push(flag);
		// A session flag's value is spent with it, and a carried one's
		// goes with it into the restart.
		else if (inline === undefined) i += 1;
	}
	return lost;
}

/**
 * What a parking pi exits with, EX_TEMPFAIL, so its holder can tell a
 * park from an end and keep the window for the wake.
 */
export const PARKED_EXIT = 75;

/**
 * Whether the holder whose wake file is `wake` runs `pid` itself, as its
 * record beside that file says. A pi started through a shell is the
 * shell's child, so its exit would reach the shell and leave a bare
 * prompt, not a park or a restart.
 */
export function heldDirectly(wake: string, pid: number): boolean {
	// A record missing or caught half written can't say this process is
	// the one held, and staying up costs only memory.
	return holderRecord(wake)?.pid === pid;
}

/**
 * The record mycelium's holder keeps beside the wake file `wake`: its
 * pid and the windows showing it. Undefined when it is missing, caught
 * half written, or not a record.
 */
export function holderRecord(
	wake: string,
): Record<string, unknown> | undefined {
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(wake.replace(/\.wake$/, ".json"), "utf8"));
	} catch {
		// Missing or half written, it says nothing of its holder.
		return undefined;
	}
	return isRecord(record) ? record : undefined;
}

/** How long a session waits idle before it parks, once parking is on. */
export const PARK_AFTER_MS = 60 * 60 * 1000;

/**
 * How long a session the switch names waits idle before it parks: long
 * enough to read what it said last, short enough to prove it on one.
 */
export const NAMED_PARK_AFTER_MS = 2 * 60 * 1000;

/**
 * Asked on the bus before a session parks. The payload names the
 * session and carries `refusals`, into which any extension holding
 * something the session must stay for (an open hold, a lease) pushes
 * why, before `emit` returns.
 */
export const PARK_ASK = "session:park-ask:v1";

/**
 * Said on the bus as a session parks, naming it, before it writes its
 * marker and exits. The mesh says `parked` in its presence, and fills
 * in the addresses it answers to and its quest, before `emit` returns.
 */
export const PARKING = "session:parking:v1";

/**
 * Said on the bus as a session starts again from a park, naming it, so
 * the mesh runs a turn over what waited for it once it has caught up:
 * a key that wakes it brings no message of its own.
 */
export const SESSION_WOKEN = "session:woken:v1";

/**
 * Asked on the bus by a rollover that has written a session's fresh log:
 * end this pi and have its holder start it again on that log, rather
 * than switch logs in this process. A pi keeps what it gathered while
 * it ran, so on 10 November those past a day held 790 MB each against
 * 242 MB for those under two hours (80ECO2 [238e1b90]), and only a new
 * process gives that back. The park watch answers before `emit`
 * returns: `restarting` once its holder will start it again, else
 * `why` not, and the rollover switches logs in this process instead.
 */
export const RESTART_ASK = "session:restart-ask:v1";

/** What {@link RESTART_ASK} carries. */
export interface RestartAsk {
	readonly session: string;
	/** The fresh log to start again on. */
	readonly sessionFile: string;
	restarting?: boolean;
	why?: string;
}

/** Whether a payload is a {@link RestartAsk}. */
export function isRestartAsk(data: unknown): data is RestartAsk {
	if (typeof data !== "object" || data === null) return false;
	const { session, sessionFile } = data as Record<string, unknown>;
	return typeof session === "string" && typeof sessionFile === "string";
}

/** What {@link PARK_ASK} carries. */
export interface ParkAsk {
	readonly session: string;
	readonly refusals: string[];
}

/** What {@link PARKING} carries. */
export interface Parking {
	readonly session: string;
	addresses: readonly string[];
	quest?: string;
	/** The file its holder wakes it on, which its presence says too. */
	readonly wake?: string;
}

/** Whether a payload is a {@link ParkAsk}. */
export function isParkAsk(data: unknown): data is ParkAsk {
	if (typeof data !== "object" || data === null) return false;
	const { session, refusals } = data as Record<string, unknown>;
	return typeof session === "string" && Array.isArray(refusals);
}

/** Whether a payload is a {@link Parking}. */
export function isParking(data: unknown): data is Parking {
	if (typeof data !== "object" || data === null) return false;
	const { session, addresses } = data as Record<string, unknown>;
	return typeof session === "string" && Array.isArray(addresses);
}

/** The folder parking keeps its switch, markers and wake files in. */
export function parkFolder(): string {
	return stateDir("park-workflow");
}

/** The switch that turns parking on while sessions run. */
export function parkSwitch(folder: string = parkFolder()): string {
	return join(folder, "switch");
}

/**
 * How long this session waits idle before it parks, or nothing while
 * parking is off for it. `PI_PARK=off` keeps it off whatever the switch
 * says. A line of the switch holding this session's id parks it after
 * {@link NAMED_PARK_AFTER_MS}, to prove parking on one session; `on` in
 * the switch, or `PI_PARK=on`, parks every session after
 * {@link PARK_AFTER_MS}. Read whenever it is asked, so the switch turns
 * running sessions on and off.
 */
export function parkAfterMs(
	session: string,
	env: NodeJS.ProcessEnv = process.env,
	switchPath: string = parkSwitch(),
): number | undefined {
	if (env[PARK_ENV] === "off") return undefined;
	const lines = switchLines(switchPath);
	if (session !== "" && lines.includes(session)) return NAMED_PARK_AFTER_MS;
	return env[PARK_ENV] === "on" || lines.includes("on")
		? PARK_AFTER_MS
		: undefined;
}

function switchLines(path: string): string[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	} catch {
		// No switch is the switch saying nothing.
		return [];
	}
}

/** What a session's marker says while it is parked. */
export interface Parked {
	readonly session: string;
	/** Its log, which `pi --session` starts it again from. */
	readonly sessionFile: string;
	/** Where it ran, which it starts in again. */
	readonly cwd: string;
	/** The mesh addresses it answers to, its signature first. */
	readonly addresses: readonly string[];
	/** The quest it had loaded, when one. */
	readonly quest?: string;
	/** When it parked, as an ISO time. */
	readonly parkedAt: string;
	/** The process that parked, gone once it has. */
	readonly pid: number;
	/** The file its holder wakes it on, written to by a sender. */
	readonly wake: string;
}

/** Whether a value reads as a marker. */
function isParkedMarker(value: unknown): value is Parked {
	if (typeof value !== "object" || value === null) return false;
	const { session, wake } = value as Record<string, unknown>;
	return typeof session === "string" && typeof wake === "string";
}

/** Where a session's marker is kept while it is parked. */
export function parkedPath(
	session: string,
	folder: string = parkFolder(),
): string {
	return join(folder, "parked", `${session}.json`);
}

/** Say this session is parked. */
export function writeParked(
	parked: Parked,
	folder: string = parkFolder(),
): void {
	writeWhole(parkedPath(parked.session, folder), `${JSON.stringify(parked)}\n`);
}

/**
 * Whether the marker at this path was written in this boot; true where
 * the machine won't say when it booted, since nothing can be judged by
 * it there. False for a marker that isn't there.
 */
function writtenThisBoot(path: string, booted: Booted): boolean {
	let written: number;
	try {
		written = statSync(path).mtimeMs;
	} catch {
		// No marker is no park.
		return false;
	}
	const boot = booted();
	return boot === undefined || written >= boot;
}

/** Whether a session is parked, as a marker from this boot says. */
export function isParked(
	session: string,
	folder: string = parkFolder(),
	booted: Booted = machineBooted,
): boolean {
	return writtenThisBoot(parkedPath(session, folder), booted);
}

/** A parked session's marker, or nothing while it isn't parked. */
export function readParked(
	session: string,
	folder: string = parkFolder(),
	booted: Booted = machineBooted,
): Parked | undefined {
	if (!isParked(session, folder, booted)) return undefined;
	try {
		const value: unknown = JSON.parse(
			readFileSync(parkedPath(session, folder), "utf8"),
		);
		return isParkedMarker(value) ? value : undefined;
	} catch {
		// No marker, or one half written, is a session not parked.
		return undefined;
	}
}

/**
 * Clear every marker the machine's boot outlived, answering the
 * sessions whose markers went. Nothing goes where the machine won't
 * say when it booted.
 */
export function clearOutlivedParks(
	folder: string = parkFolder(),
	booted: Booted = machineBooted,
): string[] {
	let names: string[];
	try {
		names = readdirSync(join(folder, "parked"));
	} catch {
		// No folder of markers is nothing parked.
		return [];
	}
	const cleared: string[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const session = name.slice(0, -".json".length);
		const path = parkedPath(session, folder);
		if (writtenThisBoot(path, booted)) continue;
		// It may have gone between the listing and now; gone is the aim.
		rmSync(path, { force: true });
		cleared.push(session);
	}
	return cleared;
}

/**
 * Where a session that may not park says why, while it stays awake. On
 * 9 November 32 of 73 sessions sat idle and awake overnight, and nothing
 * kept why, so nobody could count what kept them (KP0L6A [1631f567]).
 */
export function awakePath(
	session: string,
	folder: string = parkFolder(),
): string {
	return join(folder, "awake", `${session}.json`);
}

/** Why a session stays awake, and since when, as it last said. */
export interface Awake {
	readonly session: string;
	readonly why: string;
	readonly since: string;
}

/** Say why this session stays awake. */
export function writeAwake(awake: Awake, folder: string = parkFolder()): void {
	writeWhole(awakePath(awake.session, folder), `${JSON.stringify(awake)}\n`);
}

/** Say nothing keeps this session awake, as it parks or ends. */
export function clearAwake(
	session: string,
	folder: string = parkFolder(),
): void {
	rmSync(awakePath(session, folder), { force: true });
}

/** Say this session is parked no more, as it says on starting. */
export function clearParked(
	session: string,
	folder: string = parkFolder(),
): void {
	rmSync(parkedPath(session, folder), { force: true });
}

/**
 * Ask a parked session's holder to wake it, for this message, through
 * the file its marker names; answers whether it was asked. Anything
 * written there wakes it, so the message's id is written as a record.
 * It is renamed in whole (writeWhole), never written in place: a pi
 * host reads the id as the file appears. Mycelium's holder only looks
 * for the file once a second, and its listing reads only `.json`
 * records, so the folder the file is first written in goes unread.
 */
export function askWake(
	session: string,
	messageId: string,
	folder: string = parkFolder(),
	now: Date = new Date(),
	booted: Booted = machineBooted,
): boolean {
	const parked = readParked(session, folder, booted);
	if (!parked) return false;
	// A file created and then written could be read empty between the two.
	writeWhole(
		parked.wake,
		`${JSON.stringify({ session, messageId, at: now.toISOString() })}\n`,
	);
	return true;
}

/** What a session is doing, as far as parking asks. */
export interface Stillness extends Holding {
	/** How long since anything happened in it, in milliseconds. */
	readonly idleMs: number;
	/** How long it waits idle before parking, or nothing while off. */
	readonly afterMs: number | undefined;
	/** Why other extensions say it must stay. */
	readonly refusals: readonly string[];
}

/** Why this session may not park now, or nothing when it may. */
export function whyNotPark(at: Stillness): string | undefined {
	if (at.afterMs === undefined) return "parking is off";
	if (at.idleMs < at.afterMs) return "not idle long enough";
	return whatHolds(at) ?? at.refusals[0];
}
