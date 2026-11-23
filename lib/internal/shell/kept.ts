/**
 * What a bash call keeps of itself on disk, so another process can say
 * how it ended: its output, its exit status and its shell's pid.
 *
 * pi reads a command's output and status only through the pipes it
 * holds, and both die with it. So a session that moved to a host while
 * a command ran could never be told how it ended, and a move waited out
 * every command instead: on 12 November a wave moved none of seven
 * sessions, since each always had one running. shell-workflow's stub
 * (command-line.ts) copies the output into `<path>.out` through
 * `tee -p`, which writes on to the file once pi has gone, and writes the
 * status to `<path>.end` and the shell's pid to `<path>.pid`.
 *
 * Output on disk is output anyone could read, so the files are made
 * 0600 in a folder of 0700 under the state directory, never a shared
 * temp folder. `.out` is kept to its last `KEPT_BYTES`: past that its
 * tail moves to `.old` and `.out` starts again, so at most twice that is
 * on disk. Bytes written in the instant of that move can be lost. The
 * files go when the call ends in its pi, or once a carried call's end is
 * said; any left a week are swept as a session starts, at most once an
 * hour for a process.
 *
 * pi writes and reads these names as they stand, following a link left
 * at one, since nothing that could leave one gains by it: the agent
 * fence holds pi's state read-only to the command (fence-home.ts, and
 * fence-bwrap's test of this folder), and an unfenced command runs as
 * the person, who can write whatever a link would lead pi to.
 *
 * Making, removing and sweeping them go through libuv's pool rather than
 * pi's loop, which in a host every conversation shares: a busy disk held
 * it in these files' openat and unlink 24 times in 287 hold samples on
 * 17 November. Reading a call's status, pid and output, marking it
 * carried and rolling its output stay on the loop: they come when a move
 * or a job's record asks after a running call, at its hand-off, and each
 * 64 KB of its output, none of which the samples caught. Removing them,
 * and the job records a removal takes back, is kept-removal.ts's.
 *
 * A call handed to another process is marked `<path>.carried` until its
 * end is said, so a host that reaps what its conversations started
 * (host/engine/tool-children.ts) spares it: its shell still carries the
 * marks of the host that started it, which no longer answers for it.
 * A call handed to a job is spared the same way by its `<path>.job`
 * record (kept-jobs.ts) while its shell runs with no status written,
 * within its time limit and a day of its start, so the session can take
 * it up again however its pi or host ended.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { stateDir } from "../paths.ts";
import { processGlobal } from "../process/process-global.ts";

/** The variable a bash call's command travels in (shell-workflow's command-line.ts). */
export const COMMAND_VARIABLE = "PI_BASH_COMMAND";

/** The variable a kept call's path travels in. */
export const KEEP_VARIABLE = "PI_BASH_KEEP";

/**
 * The stub of a call that keeps itself on disk, so another process can
 * say how it ended once pi has gone. It writes its shell's pid first,
 * runs the command in a subshell, so the command's own `exit` and traps
 * can't skip what follows, and sends its output through `tee -p`, which
 * pi reads as before and which writes on to the file when pi's pipe
 * closes. Then it waits for that tee, so pi has the output before the
 * shell exits, writes the command's status and exits with it. Still one
 * line, so a failing command's line numbers are what they were.
 *
 * The tee is opened from a group, not the subshell, so it is this
 * shell's own and `$!` names it: opened by the subshell, the wait found
 * nothing, the shell could exit first, and pi, which reads a pipe only
 * briefly once its shell has gone, lost what came late. Anything the
 * command left running with its output keeps the tee open, so the wait
 * stops after a second, as the watchdog's signal says, as pi stops
 * reading what such a child writes.
 */
export const KEEPING_STUB = [
	`printf '%s\\n' "$$" > "$${KEEP_VARIABLE}.pid"`,
	`{ ( eval "unset ${COMMAND_VARIABLE} ${KEEP_VARIABLE}; $${COMMAND_VARIABLE}" ); } > >(trap '' PIPE; exec tee -p -a "$${KEEP_VARIABLE}.out") 2>&1`,
	"s=$?",
	"t=$!",
	"trap : USR1",
	"( read -t 1 <> <(:); kill -USR1 $$ ) </dev/null >/dev/null 2>&1 & w=$!",
	"wait $t 2>/dev/null",
	"kill $w 2>/dev/null",
	`printf '%s\\n' "$s" > "$${KEEP_VARIABLE}.end"`,
	"exit $s",
].join("; ");

/** The most of a command's output kept in `.out` before its tail moves to `.old`. */
export const KEPT_BYTES = 1024 * 1024;

/** How long kept files may sit before a sweep takes them as nobody's. */
export const KEPT_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Only the owner reads or writes them. */
const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;

/** The suffix of a call's record as a session's job (kept-jobs.ts). */
export const JOB_SUFFIX = ".job";

/** The suffix marking a call handed to another process. */
const CARRIED = ".carried";

/** Where kept calls go: shell-workflow's state, under XDG_STATE_HOME. */
export function keptFolder(): string {
	return join(stateDir("shell-workflow"), "kept");
}

/**
 * A new call's path in `folder`, with its `.out`, `.end` and `.pid` made
 * empty and private, so nothing the stub writes is made with the
 * command's own umask.
 */
export async function makeKept(folder: string = keptFolder()): Promise<string> {
	await mkdir(folder, { recursive: true, mode: FOLDER_MODE });
	await chmod(folder, FOLDER_MODE);
	const path = join(folder, randomUUID());
	for (const suffix of [".out", ".end", ".pid"]) {
		await writeFile(`${path}${suffix}`, "", { mode: FILE_MODE, flag: "wx" });
	}
	return path;
}

/** A whole number a kept file holds, or nothing while it holds none. */
function numberIn(file: string): number | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		// Not there: the stub hasn't written it, or the call was removed.
		return undefined;
	}
	return /^\d+\n?$/.test(text) ? Number(text.trim()) : undefined;
}

/** The exit status the call's stub wrote as it ended, or nothing yet. */
export function endOf(path: string): number | undefined {
	return numberIn(`${path}.end`);
}

/** The pid of the call's shell, as its stub wrote it first. */
export function pidOf(path: string): number | undefined {
	return numberIn(`${path}.pid`);
}

/** A file's bytes, or none when it isn't there. */
function bytesOf(file: string): Buffer {
	try {
		return readFileSync(file);
	} catch {
		// Never rolled, or already removed.
		return Buffer.alloc(0);
	}
}

/** The call's output, its last `KEPT_BYTES` at most. */
export function outputOf(path: string): string {
	const all = Buffer.concat([bytesOf(`${path}.old`), bytesOf(`${path}.out`)]);
	return all.subarray(Math.max(0, all.length - KEPT_BYTES)).toString("utf8");
}

/**
 * Once `.out` holds more than `cap`, move its last `cap` bytes to `.old`
 * and start it again. tee appends, so it writes on from the start.
 */
export function rollIfFull(path: string, cap: number = KEPT_BYTES): void {
	const out = `${path}.out`;
	try {
		if (statSync(out).size <= cap) return;
		const bytes = readFileSync(out);
		writeFileSync(`${path}.old`, bytes.subarray(bytes.length - cap), {
			mode: FILE_MODE,
		});
		truncateSync(out, 0);
	} catch {
		// Removed under it, as its call ended: nothing left to keep short.
	}
}

/**
 * Mark the call handed to another process, which says its end, with the
 * call's own mark (`PI_BASH_CALL`) when it has one.
 */
export function markCarried(path: string, mark = ""): void {
	try {
		writeFileSync(`${path}${CARRIED}`, mark, { mode: FILE_MODE });
	} catch {
		// Removed under it, as its call ended: nothing left to spare.
	}
}

/** Whether the call at `path` is still marked handed on: its end not yet said. */
export function isMarkedCarried(path: string): boolean {
	return existsSync(`${path}${CARRIED}`);
}

/** The calls handed to another process, as a reaper tells them apart. */
export interface CarriedCalls {
	/** Their marks, which every process a call starts inherits. */
	readonly marks: ReadonlySet<string>;
	/** Their shells' process groups: each shell leads its own. */
	readonly groups: ReadonlySet<number>;
}

/**
 * How long a recorded call is spared after it started, at most: as long
 * as a host lets a call it carried run on with nobody holding it.
 */
export const RECORD_SPARED_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * The calls in `folder` handed to another process, until its shell
 * writes how it ended, or to a job its session takes up again, while
 * its shell runs, within its time limit and a day of its start. A call's
 * mark reaches what it started in a group of its own, as `timeout` and
 * `setsid` make; its shell's group covers a call run without one.
 */
export function carriedCalls(
	folder: string = keptFolder(),
	now: number = Date.now(),
): CarriedCalls {
	const marks = new Set<string>();
	const groups = new Set<number>();
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder yet: nothing was ever kept, so nothing is carried.
		return { marks, groups };
	}
	for (const name of names) {
		if (name.endsWith(JOB_SUFFIX)) {
			const path = join(folder, name.slice(0, -JOB_SUFFIX.length));
			// Once its status is written nothing of it runs to spare.
			if (endOf(path) !== undefined) continue;
			const spared = recordedSpare(`${path}${JOB_SUFFIX}`);
			if (spared === undefined || !sparedAt(spared, now)) continue;
			groups.add(spared.pid);
			if (spared.mark !== "") marks.add(spared.mark);
			continue;
		}
		if (!name.endsWith(CARRIED)) continue;
		const path = join(folder, name.slice(0, -CARRIED.length));
		const pid = pidOf(path);
		if (pid !== undefined) groups.add(pid);
		const mark = textOf(`${path}${CARRIED}`).trim();
		if (mark !== "") marks.add(mark);
	}
	return { marks, groups };
}

/** What a job's record says of its call, as a reaper spares it. */
interface RecordedSpare {
	readonly pid: number;
	readonly mark: string;
	readonly startedAt: number;
	readonly deadline?: number;
}

/** What a job's record says of its call, or nothing when it says none. */
function recordedSpare(file: string): RecordedSpare | undefined {
	let record: unknown;
	try {
		record = JSON.parse(textOf(file));
	} catch {
		// Gone as its call ended: nothing of it runs to spare.
		return undefined;
	}
	if (typeof record !== "object" || record === null || !("work" in record))
		return undefined;
	const { work } = record;
	if (typeof work !== "object" || work === null) return undefined;
	if (!("pid" in work) || typeof work.pid !== "number") return undefined;
	if (!("startedAt" in work) || typeof work.startedAt !== "number")
		return undefined;
	const mark = "mark" in work && typeof work.mark === "string" ? work.mark : "";
	const deadline =
		"deadline" in work && typeof work.deadline === "number"
			? work.deadline
			: undefined;
	return {
		pid: work.pid,
		mark,
		startedAt: work.startedAt,
		...(deadline !== undefined ? { deadline } : {}),
	};
}

/**
 * Whether a recorded call is spared `now`: its shell, which leads its
 * group, still there, within its time limit and a day of its start.
 */
function sparedAt(spared: RecordedSpare, now: number): boolean {
	if (spared.deadline !== undefined && now >= spared.deadline) return false;
	if (now >= spared.startedAt + RECORD_SPARED_FOR_MS) return false;
	return processThere(spared.pid);
}

/** Whether the process `pid` runs, someone else's or not. */
export function processThere(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: there, though not ours to signal; anything else, gone.
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/** What a kept file holds, or nothing once it is gone. */
function textOf(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		// Removed as its call's end was said: nothing left to spare.
		return "";
	}
}

/** Remove the files in `folder` nothing has touched for `olderThanMs`. */
export async function sweepKept(
	folder: string = keptFolder(),
	now: number = Date.now(),
	olderThanMs: number = KEPT_FOR_MS,
): Promise<void> {
	let names: string[];
	try {
		names = await readdir(folder);
	} catch {
		// No folder yet: nothing was ever kept.
		return;
	}
	for (const name of names) {
		const file = join(folder, name);
		try {
			if (now - (await stat(file)).mtimeMs > olderThanMs) await rm(file);
		} catch {
			// Removed meanwhile by the call it belonged to.
		}
	}
}

/** How often at most a process sweeps the kept folder, however many sessions start. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000;

// When each folder was last swept, for the whole process and every copy
// of this module: a host starts every conversation in one process, and
// a sweep for each would read the whole folder each time.
const sweptAt = processGlobal(
	"agentic-harness.internal/shell/kept-swept-at.v1",
	() => new Map<string, number>(),
);

/**
 * Sweep `folder` as {@link sweepKept} does, unless this process began a
 * sweep of it within the hour. Marked as it begins, so starts that come
 * while it runs don't begin another; a clock stepped back before the
 * mark sweeps at once rather than waiting out however far it stepped.
 */
export function sweepKeptNowAndThen(
	folder: string = keptFolder(),
	now: number = Date.now(),
): Promise<void> {
	const last = sweptAt.get(folder);
	if (last !== undefined && now >= last && now - last < SWEEP_EVERY_MS)
		return Promise.resolve();
	sweptAt.set(folder, now);
	return sweepKept(folder, now);
}

/** What {@link teePersists} found, or is finding, by the PATH it was asked with. */
const persistsOn = new Map<string, Promise<boolean>>();

/** How long tee may take to say whether it takes `-p`. */
const TEE_TIMEOUT_MS = 5000;

/**
 * Whether the `tee` that `path` finds writes on to its file once its
 * other output has gone (`-p`, GNU's): without it the stub can't keep a
 * call past its pi, and its calls hold a move, as every call did before.
 * Asked of a command's own PATH, since a hosted conversation's need not
 * be the process's.
 *
 * Asked as each bash call starts, so tee is waited on without holding
 * pi's loop: a host runs every conversation on that loop, and the
 * synchronous ask this was cost one turn 412 ms in a soak of twelve (13
 * November). Each PATH is asked once, its answer shared by every call
 * that asks while tee runs.
 */
export function teePersists(
	path: string | undefined = process.env.PATH,
): Promise<boolean> {
	const key = path ?? "";
	const known = persistsOn.get(key);
	if (known !== undefined) return known;
	const asked = askTee(path);
	persistsOn.set(key, asked);
	return asked;
}

/** Run `tee -p` on empty input, under `path`, and hear whether it took it. */
function askTee(path: string | undefined): Promise<boolean> {
	return new Promise((resolve) => {
		const tee = spawn("tee", ["-p", "/dev/null"], {
			stdio: ["pipe", "ignore", "ignore"],
			timeout: TEE_TIMEOUT_MS,
			...(path === undefined ? {} : { env: { ...process.env, PATH: path } }),
		});
		// No tee on the PATH, or one that could not start: it does not persist.
		tee.once("error", () => resolve(false));
		tee.once("close", (status) => resolve(status === 0));
		tee.stdin?.on("error", () => {
			// A tee that exits before reading leaves the pipe closed; its
			// status still says what it took.
		});
		tee.stdin?.end();
	});
}

/** Whether `shellPath` is bash, whose process substitution the stub needs. */
export function isBash(shellPath: string | undefined): boolean {
	return shellPath === undefined || basename(shellPath) === "bash";
}
