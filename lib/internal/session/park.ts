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
 * conversation or send that prompt again. Where the holder names a
 * file for it ({@link PARKED_ENV}), the pi writes it as it parks, so a
 * park whose exit hangs and ends by a signal still reads as one. The
 * marker names the file as `wake`, and a sender writes to it when its
 * message would give a parked peer a turn (see mesh/parked.ts); the
 * mesh keeps unread messages on disk until a peer's next start, so
 * nothing sent to a parked peer is lost.
 *
 * A holder that watches steers too names a file for them
 * ({@link STEERS_ENV}), and the pi writes there, as it parks, the steer
 * inboxes the mesh says are its own and which steers wake it
 * ({@link HolderSteers}), so the person's talk wakes it as it lands
 * rather than at a running peer's next look, a minute on.
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

import {
	lstatSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Booted, machineBooted } from "../machine/booted.ts";
import { stateDir } from "../paths.ts";
import { isRecord } from "../record.ts";
import { writeWhole } from "../write-whole.ts";
import { carriedEnvironment } from "./carried-environment.ts";
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
 * Where the holder takes the steer inboxes it watches while this pi is
 * parked ({@link HolderSteers}), written as it parks. A holder that sets
 * none wakes it for a steer only as a running peer asks, through its
 * wake file.
 */
export const STEERS_ENV = "MYCELIUM_STEERS";

/**
 * Where the holder keeping this pi takes its word that the run parked,
 * a file the holder clears before each run. A pi writes it as it
 * commits to exiting {@link PARKED_EXIT}, so a run whose exit then
 * hangs, as one waiting on a name lookup does, and ends by a signal
 * still counts as parked. On 21 November Mac parks that ended so lost
 * their holders, which keep a window only on that exit code. A holder
 * that sets none reads the exit code alone.
 */
export const PARKED_ENV = "MYCELIUM_PARKED";

/**
 * Which steers wake a parked peer, said as data for a holder in another
 * language to judge the steer files it sees by: an act it names, a
 * resume with words when `resumeWithWords`, and words with no act when
 * `talk`. The mesh's own judge reads it too (mesh/parked.ts).
 */
export interface WakingSteers {
	readonly acts: readonly string[];
	readonly talk: boolean;
	readonly resumeWithWords: boolean;
}

/** What a holder is told of a parking pi's steers ({@link STEERS_ENV}). */
export interface HolderSteers {
	/** The absolute folders its steers land in, one per address. */
	readonly inboxes: readonly string[];
	readonly wakes: WakingSteers;
}

/**
 * Tell the holder at `file` what `steers` says, written whole so it never
 * reads half, or clear what an earlier park told it when there is
 * nothing to say.
 */
export function tellHolderSteers(
	file: string,
	steers: HolderSteers | undefined,
): void {
	if (steers === undefined || steers.inboxes.length === 0) {
		rmSync(file, { force: true });
		return;
	}
	writeWhole(file, `${JSON.stringify(steers)}\n`);
}

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
 * The command a holder starts the session again with: the
 * {@link restartCommand}, behind `env` naming each carried variable
 * this pi was started with (`carried-environment.ts`), since a holder
 * runs the command it is given in its own environment.
 */
export function holderCommand(
	sessionFile: string,
	args: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const carried = Object.entries(carriedEnvironment(env) ?? {}).map(
		([name, value]) => `${name}=${value}`,
	);
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
 * Whether pi's arguments give it a prompt: words that are no flag nor a
 * flag's value, or anything after `--`. A pi that never took its prompt
 * can't hand its window on as though the conversation had.
 */
export function promptIn(args: readonly string[]): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--") return i + 1 < args.length;
		if (!arg.startsWith("-") || arg === "-") return true;
		const [flag = "", inline] = arg.split(/[=](.*)/s, 2);
		const valued = SESSION_FLAGS.has(flag) || CARRIED_FLAGS.has(flag);
		if (valued && inline === undefined) i += 1;
	}
	return false;
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

/** Where a pi its holder runs itself names what starts next, and asks to be woken into it. */
export interface HolderFiles {
	/** The wake file, which written before the pi ends starts the next at once. */
	readonly wake: string;
	/** The file naming the command the holder starts next. */
	readonly again: string;
	/** The file that says the run parked, where its holder names one. */
	readonly parked?: string;
}

/**
 * The {@link HolderFiles} of the pi `pid` running with `env`, or nothing
 * when no holder runs it itself or its holder takes no next command.
 */
export function holderFiles(
	env: NodeJS.ProcessEnv,
	pid: number,
): HolderFiles | undefined {
	const wake = env[WAKE_ENV] ?? "";
	const again = env[AGAIN_ENV] ?? "";
	if (wake === "" || again === "") return undefined;
	if (!heldDirectly(wake, pid)) return undefined;
	const parked = env[PARKED_ENV] ?? "";
	return parked === "" ? { wake, again } : { wake, again, parked };
}

/**
 * Tells the holder running `pid` that this run parked, by writing the
 * file it named in {@link PARKED_ENV}, empty. It writes nothing where
 * no holder runs this process itself, as for a subagent that inherited
 * the variable, or where the holder names no file.
 */
export function sayParked(env: NodeJS.ProcessEnv, pid: number): void {
	const parked = env[PARKED_ENV] ?? "";
	const wake = env[WAKE_ENV] ?? "";
	if (parked === "" || wake === "" || !heldDirectly(wake, pid)) return;
	sayParkedIn(parked);
}

/**
 * Takes back what {@link sayParked} wrote for a run that is up after
 * all, as one replaced in place, whose holder sees no exit and so never
 * clears it: left, a later quit whose exit hangs would count as a park.
 * Like sayParked, it touches nothing where no holder runs `pid` itself,
 * as for a subagent that inherited the variable from a parent whose
 * mark is real.
 */
export function unsayParked(env: NodeJS.ProcessEnv, pid: number): void {
	const parked = env[PARKED_ENV] ?? "";
	const wake = env[WAKE_ENV] ?? "";
	if (parked === "" || wake === "" || !heldDirectly(wake, pid)) return;
	try {
		rmSync(parked, { force: true });
	} catch {
		// Left in place, only a quit whose exit then hangs is misread.
	}
}

/**
 * Names the process whose restart in place said its park, set on the
 * pi it becomes, so that pi takes back that park and no other: a mark
 * written as a session starts, as one-writer's hand-over to the host's
 * view writes one, is a real park.
 */
export const PARK_SAID_ENV = "PI_PARK_SAID_BY";

/**
 * Takes back the park a restart in place of process `pid` said, once
 * it is up as the pi that restart became, and forgets the restart, so
 * no later start in this process, nor a subagent it spawns, acts on it.
 * A mark that anything else wrote stands.
 */
export function takeBackRestartPark(env: NodeJS.ProcessEnv, pid: number): void {
	const saidBy = env[PARK_SAID_ENV];
	if (saidBy === undefined) return;
	delete env[PARK_SAID_ENV];
	if (saidBy === String(pid)) unsayParked(env, pid);
}

/** Writes the holder's parked file `parked`, empty. */
export function sayParkedIn(parked: string): void {
	try {
		writeFileSync(parked, "");
	} catch {
		// Unwritten, the holder reads the exit code alone, as it did before
		// it named a file; only an exit that then hangs is lost, as before.
	}
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

/**
 * How long a session waits idle before it parks, once parking is on:
 * half an hour, since a window in sight never parks and a key wakes one
 * in seconds, while each idle one holds a quarter of a gigabyte or more.
 */
export const PARK_AFTER_MS = 30 * 60 * 1000;

/**
 * How old a pi process is before it parks sooner: on 15 November one
 * over a day old held 481 MiB against 267 MiB for one under an hour,
 * since what a long run gathers stays with the process, and a wake
 * starts a fresh one.
 */
export const OLD_PI_MS = 24 * 60 * 60 * 1000;

/** How long a pi process over {@link OLD_PI_MS} old waits idle before it parks. */
export const OLD_PARK_AFTER_MS = 10 * 60 * 1000;

/**
 * How long a session the switch names waits idle before it parks: long
 * enough to read what it said last, short enough to prove it on one.
 */
export const NAMED_PARK_AFTER_MS = 2 * 60 * 1000;

/**
 * How long a background host's conversation waits idle before it parks.
 * Since 20 November each runs in a process of its own, which parking
 * ends: at 06:58 on 21 November 75 background conversations held about
 * 20 GB, and 37 of them had sent nothing for five minutes. One no
 * window views is read by no one, so a wake's 38 s falls on an agent;
 * one a window views waits its usual time, as the person may be reading it.
 * Never on macOS, which keeps the usual limit until a Mac's host survives
 * a park.
 */
export const BACKGROUND_PARK_AFTER_MS = 5 * 60 * 1000;

/** How long a session's wakes are kept, to count how often it wakes. */
export const WAKES_KEPT_MS = 24 * 60 * 60 * 1000;

/** One wake of a parked session, and how long it rested before it. */
export interface Wake {
	/** When it parked, as its marker said, as an ISO time; empty when it didn't say. */
	readonly parkedAt: string;
	/** The host it woke in, as `realm-kind`, when a host holds it. */
	readonly host?: string;
	/**
	 * The idle limit it parked under, as its marker said: 0 for a host's
	 * drain, so a restart's wakes aren't counted against a rule.
	 */
	readonly afterMs?: number;
	/**
	 * It parked between turns of a run as its host drained or rolled, its
	 * own wake written as it parked, so its rest is the host's and no rule's.
	 */
	readonly goesOn?: boolean;
	/** When it started again, as an ISO time. */
	readonly wokeAt: string;
	/** How long it rested parked, in milliseconds. */
	readonly restedMs: number;
}

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
	/**
	 * Its person asked for it (`/harness restart`), at a moment they
	 * chose, so their being at its window doesn't hold it back.
	 */
	readonly asked?: boolean;
	restarting?: boolean;
	why?: string;
}

/** Whether a payload is a {@link RestartAsk}. */
export function isRestartAsk(data: unknown): data is RestartAsk {
	if (typeof data !== "object" || data === null) return false;
	const { session, sessionFile } = data as Record<string, unknown>;
	return typeof session === "string" && typeof sessionFile === "string";
}

/**
 * Asked on the bus by the person's Park from outside the window
 * (mesh-workflow pausing.ts): park now, however briefly it has been
 * idle, unless something else holds it. Joel, 24 November, by 42P0R4
 * [f00e0dec]: hold a cell parked from the launcher, so its process ends
 * and frees memory, then wake it on a message, a key or a window. The
 * park watch answers before `emit` returns: `parked` once it parks, else
 * `why` not. An ask nobody answers has no watch, since nothing here
 * would wake it.
 */
export const PARK_NOW_ASK = "session:park-now-ask:v1";

/** What {@link PARK_NOW_ASK} carries. */
export interface ParkNowAsk {
	readonly session: string;
	parked?: boolean;
	why?: string;
}

/** Whether a payload is a {@link ParkNowAsk}. */
export function isParkNowAsk(data: unknown): data is ParkNowAsk {
	if (typeof data !== "object" || data === null) return false;
	return typeof (data as Record<string, unknown>).session === "string";
}

/** What {@link PARK_ASK} carries. */
export interface ParkAsk {
	readonly session: string;
	readonly refusals: string[];
	/**
	 * Asked for a restart, not a park: the same process comes back in
	 * seconds on the same session, so what only a park would lose (its
	 * sessions' findings, a hold it sent) doesn't refuse it.
	 */
	readonly restart?: boolean;
	/**
	 * Asked for a park its wake follows at once, mid-run as its host drains
	 * or rolls: it goes on in its host's next start, so what only a long
	 * rest would lose (its sessions' findings, a hold it sent) doesn't
	 * refuse it, as for a restart. Standing at the launcher's top still
	 * does, since that start would hold up the person's next line.
	 */
	readonly goesOn?: boolean;
}

/** What {@link PARKING} carries. */
export interface Parking {
	readonly session: string;
	addresses: readonly string[];
	quest?: string;
	/** The file its holder wakes it on, which its presence says too. */
	readonly wake?: string;
	/** Its steer inboxes and which steers wake it, as the mesh says. */
	steers?: HolderSteers;
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
 * The file through which the node asks `session` to park soon, while
 * its machine reads over: its presence is the ask, and its line (when
 * and why) is for people, never read for meaning.
 */
export function easePath(
	session: string,
	folder: string = parkFolder(),
): string {
	return join(folder, "ease", session);
}

/**
 * How long an ask to park soon stands once written: the node writes it
 * again while its machine still reads over, so an ask a crashed node,
 * a stuck sensor or a killed session left behind lapses on its own
 * rather than parking its session two minutes after every turn.
 */
export const EASE_LASTS_MS = 30 * 60 * 1000;

/**
 * How long a background conversation asked to park soon waits idle: as
 * long as one the switch names, long enough to read what it said last,
 * but its own rule, for memory rather than a trial.
 */
export const EASED_PARK_AFTER_MS = 2 * 60 * 1000;

/**
 * How far ahead of now an ask may be dated and still count: the skew two
 * clocks on one machine may show. One dated later, by a clock stepped
 * back or a copy that kept its times, would not lapse when it should,
 * so it is none, and taken back so it can't count once the clock
 * catches up.
 */
export const EASE_SKEW_MS = 60 * 1000;

// A session id names a file of its own in `ease/`, never one elsewhere:
// it comes from a log's header, and a log can come from another machine.
const namesOwnFile = (session: string) =>
	session !== "" &&
	session !== "." &&
	session !== ".." &&
	basename(session) === session;

/**
 * Whether the node has asked `session` to park soon, by an ease file in
 * `folder`, a regular file of one name and no link, written within
 * {@link EASE_LASTS_MS}. One dated past {@link EASE_SKEW_MS} ahead is
 * taken back, so it can't count once the clock catches up.
 */
export function isEased(
	session: string,
	folder: string = parkFolder(),
	now: number = Date.now(),
): boolean {
	if (!namesOwnFile(session)) return false;
	try {
		const ask = lstatSync(easePath(session, folder));
		// A link, hard or soft, may share a busy file's times and never lapse.
		if (!ask.isFile() || ask.nlink !== 1) return false;
		const age = now - ask.mtimeMs;
		if (age < -EASE_SKEW_MS) {
			clearEase(session, folder);
			return false;
		}
		return age <= EASE_LASTS_MS;
	} catch {
		// No file is no ask.
		return false;
	}
}

/** Take back an ask to park soon, as its session wakes or parks. */
export function clearEase(
	session: string,
	folder: string = parkFolder(),
): void {
	if (!namesOwnFile(session)) return;
	try {
		rmSync(easePath(session, folder), { force: true });
	} catch {
		// An ask left behind parks this session soon once more, until it
		// lapses or the node takes it back once the machine reads calm.
	}
}

/**
 * Whether the switch at `switchPath` holds the line `off`, which keeps
 * the node's asks to ease from parking anyone, so emptying the switch
 * and writing `off` stops every park but a session it names and a
 * host's drain (park-workflow's README), one file a person edits. A Mac's switch already holds `off` beside the names
 * it parks, which park as before.
 */
export function switchOff(switchPath: string = parkSwitch()): boolean {
	try {
		return readFileSync(switchPath, "utf8")
			.split("\n")
			.some((line) => line.trim() === "off");
	} catch (error) {
		// No switch says nothing; one there that this account can't read
		// may say off, so it is taken as off, the kill switch failing shut.
		// A switch rewritten in place can read empty for a moment: it is
		// only as atomic as whoever writes it.
		return !(
			error instanceof Error &&
			"code" in error &&
			error.code === "ENOENT"
		);
	}
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

/**
 * What became of a parking session's windows: those it closed, and why
 * any stayed open, so a sleeper's window still there says why.
 */
export interface WindowsLeft {
	/** The windows closed, by their terminal's id and their class. */
	readonly closed: readonly { readonly id: string; readonly appId: string }[];
	/** Why a window stayed open, when one did. */
	readonly open?: string;
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
	/** The idle limit it parked under, in milliseconds: 0 in a drain. */
	readonly afterMs?: number;
	/** The process that parked, gone once it has. */
	readonly pid: number;
	/** The file its holder wakes it on, written to by a sender. */
	readonly wake: string;
	/** What became of its windows, once it tried to close them. */
	readonly windows?: WindowsLeft;
	/** It parked between turns of a run, woken as it parked, to go on in the next start. */
	readonly goesOn?: boolean;
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
 * Every session parked with this quest loaded, as markers from this
 * boot say, in the order of their names.
 */
export function parkedWithQuest(
	quest: string,
	folder: string = parkFolder(),
	booted: Booted = machineBooted,
): Parked[] {
	let names: string[];
	try {
		names = readdirSync(join(folder, "parked"));
	} catch {
		// No folder of markers is nothing parked.
		return [];
	}
	return names
		.sort()
		.filter((name) => name.endsWith(".json"))
		.map((name) => readParked(name.slice(0, -".json".length), folder, booted))
		.filter((parked): parked is Parked => parked?.quest === quest);
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

/**
 * Where a session keeps its wakes of the last day, so a park rule that
 * wakes its sessions too often shows as a count rather than a guess.
 */
export function wakesPath(
	session: string,
	folder: string = parkFolder(),
): string {
	return join(folder, "wakes", `${session}.json`);
}

/** Whether a value reads as a wake. */
function isWake(value: unknown): value is Wake {
	return (
		isRecord(value) &&
		typeof value.parkedAt === "string" &&
		typeof value.wokeAt === "string" &&
		typeof value.restedMs === "number" &&
		(value.host === undefined || typeof value.host === "string") &&
		(value.afterMs === undefined || typeof value.afterMs === "number")
	);
}

/** A session's wakes of the last day, oldest first. */
export function readWakes(
	session: string,
	folder: string = parkFolder(),
): Wake[] {
	try {
		const value: unknown = JSON.parse(
			readFileSync(wakesPath(session, folder), "utf8"),
		);
		return Array.isArray(value) ? value.filter(isWake) : [];
	} catch {
		// None kept yet, or a file half written, is no wakes to count.
		return [];
	}
}

/**
 * Note that this session woke from the park its marker records, in the
 * host named when one holds it and under the limit the marker names,
 * keeping only the last day's wakes, and
 * sweep away other sessions' wakes a day old; answers the wake noted.
 * A marker that never said when it parked still counts as a wake, one
 * whose rest reads 0.
 */
export function noteWake(
	session: string,
	parked: {
		readonly parkedAt?: unknown;
		readonly afterMs?: unknown;
		readonly host?: string;
		readonly goesOn?: unknown;
	},
	folder: string = parkFolder(),
	now: () => number = Date.now,
): Wake {
	const at = now();
	const parkedAt = typeof parked.parkedAt === "string" ? parked.parkedAt : "";
	const since = Date.parse(parkedAt);
	const wake: Wake = {
		parkedAt,
		...(parked.host === undefined ? {} : { host: parked.host }),
		...(typeof parked.afterMs === "number" ? { afterMs: parked.afterMs } : {}),
		...(parked.goesOn === true ? { goesOn: true } : {}),
		wokeAt: new Date(at).toISOString(),
		restedMs: Number.isNaN(since) ? 0 : Math.max(0, at - since),
	};
	const kept = readWakes(session, folder).filter(
		(earlier) => at - Date.parse(earlier.wokeAt) < WAKES_KEPT_MS,
	);
	writeWhole(
		wakesPath(session, folder),
		`${JSON.stringify([...kept, wake])}\n`,
	);
	void sweepWakes(folder, at).catch(() => {
		// What it couldn't sweep now, the next wake sweeps.
	});
	return wake;
}

/**
 * Remove the wakes of every session that hasn't woken for a day, off the
 * thread, since a session that never wakes again would keep its file for
 * good, and listing and statting the folder on an attended host's thread
 * would hold every conversation it serves.
 */
export async function sweepWakes(
	folder: string = parkFolder(),
	at: number = Date.now(),
): Promise<void> {
	const wakes = join(folder, "wakes");
	let names: string[];
	try {
		names = await readdir(wakes);
	} catch {
		// No wakes kept yet is nothing to sweep.
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(wakes, name);
		try {
			if (at - (await stat(path)).mtimeMs >= WAKES_KEPT_MS) {
				await rm(path, { force: true });
			}
		} catch {
			// Gone since the listing, which is what the sweep is for.
		}
	}
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
