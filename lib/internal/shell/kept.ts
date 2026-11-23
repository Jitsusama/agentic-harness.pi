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
 * Making, removing and sweeping them go through libuv's pool rather than
 * pi's loop, which in a host every conversation shares: a busy disk held
 * it in these files' openat and unlink 24 times in 287 hold samples on
 * 17 November. Reading a call's status, pid and output, marking it
 * carried and rolling its output stay on the loop: they come when a move
 * or a job's record asks after a running call, at its hand-off, and each
 * 64 KB of its output, none of which the samples caught. A removal takes
 * turns of the loop, so it removes the marks that would have a call taken
 * up again before its status, and a pi ended partway through leaves no
 * call that reads as running.
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
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { count } from "../../ui/count.ts";
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

/**
 * Every file a call keeps, in the order they are removed: the marks that
 * have it taken up again first, then its status, so a removal cut short
 * leaves no call that reads as running. A carried call taken up has both
 * marks, and one cut between them can still have its end said again.
 */
const SUFFIXES = [".job", ".carried", ".end", ".pid", ".out", ".old"] as const;

/** The suffixes that have a call taken up again. */
const MARKS: ReadonlySet<string> = new Set([".job", ".carried"]);

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

/** The removals of a call's files still short of its marks. */
interface Ending {
	/** How many run. */
	removals: number;
	/** The marks they may find, which an exit takes back. */
	readonly marks: Set<string>;
}

/** A removal of a job record this process wrote, still running. */
export interface JobRecordRemoval {
	/** Whether its call was handed on while it ran. */
	handed: boolean;
	/**
	 * The record this process wrote again while it ran, as a rollover's
	 * recorder does, when the call was handed on before that was removed.
	 */
	latest?: string;
	/**
	 * Whether its call's files went while it ran, by whoever removed them
	 * (its own end, a taker in this process, or a move that couldn't be
	 * written), so nothing is put back for one.
	 */
	gone: boolean;
	/** Whether the record is off its name, set aside, and not yet put back. */
	setAside: boolean;
}

// The kept paths whose job record (kept-jobs.ts) this process wrote and
// hasn't taken back, each with the record it wrote, so a call that wrote
// none asks nothing of the disk as it ends, and the removals of such
// records still running, so a hand-off meanwhile can put the record
// back for its taker from what this process wrote. For the process
// rather than a module copy: pi loads each extension as a copy of its
// own, and job-workflow records a job while shell-workflow ends its
// call, so the two always sit in different copies, and a reload makes
// another. Kept here, beside `removeKept`, since every way a call's
// files go passes through it. Each path is a call's own, so
// conversations never share one. The key names the shape: a copy loaded
// under another key would see none of these, and its calls would leave
// their records to `removeKept` just after. Beside them: how many of
// `removeKept`'s removals of each call run, with the marks they may
// find, and whether the process
// takes back, as it exits, what those and the record removals had yet
// to remove, asked once however many copies there are and done by the
// copy loaded last, so a reload's fix reaches it. A call begun under a
// copy older than this store and written again by a newer one is held
// here though the old copy removes its files, so its session's close
// unlinks a missing name on the thread once: only for the calls that
// span the reload onto it.
const jobRecords = processGlobal(
	"agentic-harness.internal/shell/kept-jobs/records.v5",
	() => ({
		own: new Map<string, string>(),
		removing: new Map<string, JobRecordRemoval>(),
		ending: new Map<string, Ending>(),
		hooked: false,
		takeBack: (): void => undefined,
	}),
);

/** Note that this process wrote `record`, the job record of the call kept at `path`. */
export function ownJobRecord(path: string, record: string): void {
	jobRecords.own.set(path, record);
}

/** Whether this process holds a job record it wrote for the call kept at `path`. */
export function ownsJobRecord(path: string): boolean {
	return jobRecords.own.has(path);
}

/**
 * Let go of the job record of the call kept at `path` as this process's,
 * answering the record it wrote, or nothing when there is none it holds.
 */
export function takeJobRecord(path: string): string | undefined {
	const record = jobRecords.own.get(path);
	jobRecords.own.delete(path);
	return record;
}

/**
 * Let go of the job record of the call kept at `path` as its call is
 * handed on, marking a removal of it still running as handed.
 */
export function handJobRecordOn(path: string): void {
	const latest = takeJobRecord(path);
	const removal = jobRecords.removing.get(path);
	if (removal === undefined) return;
	removal.handed = true;
	if (latest !== undefined) removal.latest = latest;
}

/**
 * Let go of the job record of the call kept at `path` as its files go,
 * marking a removal of it still running as gone, so nothing puts it back
 * beside its end.
 */
function letJobRecordGo(path: string): void {
	jobRecords.own.delete(path);
	const removal = jobRecords.removing.get(path);
	if (removal !== undefined) removal.gone = true;
}

/**
 * Begin removing the job record of the call kept at `path`, answering
 * the removal, or nothing when this process wrote none to remove or one
 * removal of it runs already: that one takes a record written again
 * too, unless the call was handed on meanwhile, when the record is its
 * taker's, which goes with the call's files.
 */
export function beginJobRecordRemoval(
	path: string,
): JobRecordRemoval | undefined {
	if (!jobRecords.own.has(path) || jobRecords.removing.has(path))
		return undefined;
	const removal: JobRecordRemoval = {
		handed: false,
		gone: false,
		setAside: false,
	};
	jobRecords.removing.set(path, removal);
	takeBackAtExit();
	return removal;
}

/**
 * Whether a removal of the job record kept at `path` runs for a call not
 * handed on, so it takes each record it finds there in turn, one written
 * again included.
 */
export function removingUnhanded(path: string): boolean {
	const removal = jobRecords.removing.get(path);
	return removal !== undefined && !removal.handed;
}

/** What the process runs as it exits: the newest copy's take-back. */
const takeRecordsBackAtExit = (): void => jobRecords.takeBack();

/** Have the process take back, as it exits, what its disk had yet to remove. */
function takeBackAtExit(): void {
	if (jobRecords.hooked) return;
	jobRecords.hooked = true;
	process.on("exit", takeRecordsBackAtExit);
}

/**
 * Take back, on the thread, what the disk had yet to remove as the
 * process exits, since its pool does nothing more once it has, and a
 * record or carried mark left would stand beside the call's end for its
 * next start to say again: the record of each removal still running
 * for a call not handed on, or whose files went, as one put back for a
 * taker can land after they did, and the marks of each call
 * `removeKept` may find and has yet to get past. Only an exit does it, never a
 * session's close, since in a host the process lives on and the disk
 * gets to them off the thread; a pi killed outright runs nothing, and
 * its next start says the call's end again. Each waits on the disk that
 * left it, so how many names it asks after is said first, for a slow
 * exit to be read by: up to that many, since a mark may never have been
 * written.
 */
function takeRecordsBack(): void {
	const records = [...jobRecords.removing]
		.filter(([, removal]) => !removal.handed || removal.gone)
		.map(([path]) => `${path}${JOB_SUFFIX}`);
	const marks = [...jobRecords.ending].flatMap(([path, ending]) =>
		[...ending.marks].map((mark) => `${path}${mark}`),
	);
	const files = [...new Set([...records, ...marks])];
	if (files.length === 0) return;
	try {
		process.stderr.write(
			`[shell] taking back up to ${count(files.length, "kept file")} the disk had yet to remove as pi exits\n`,
		);
	} catch {
		// Its error output gone with whatever read it; the files still go.
	}
	for (const file of files) unlinkNow(file);
}
jobRecords.takeBack = takeRecordsBack;

/** Remove `file` on the thread, as a process exiting does. */
function unlinkNow(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		// Only something other than a file holds the name, which nothing
		// here writes; the process is going, so nothing could say it.
	}
}

/** Note that `removal` of the job record kept at `path` has ended. */
export function endJobRecordRemoval(
	path: string,
	removal: JobRecordRemoval,
): void {
	if (jobRecords.removing.get(path) === removal)
		jobRecords.removing.delete(path);
}

/**
 * Remove everything a call kept. It never fails, so a caller that has
 * nothing to wait for can leave it to run. A mark it can't remove stops
 * it there, leaving the call's status beside the mark so whatever finds
 * it reads the call as ended; any other file it can't remove it passes.
 * As it begins, its record is no longer this process's, a removal of
 * the record still running is marked gone so nothing puts it back, and
 * a process exiting before it is past its marks takes them back: both,
 * but for a call that ran here and was never handed on, whose only mark
 * can be the record this process holds for it, so an exit on a slow
 * disk asks after no name its call never wrote.
 */
export async function removeKept(
	path: string,
	{ ranHere = false }: { ranHere?: boolean } = {},
): Promise<void> {
	const mayHold = marksFound(path, ranHere);
	letJobRecordGo(path);
	takeBackAtExit();
	if (!(await removeMarks(path, mayHold))) return;
	for (const suffix of SUFFIXES) {
		if (MARKS.has(suffix)) continue;
		try {
			await rm(`${path}${suffix}`, { force: true });
		} catch {
			// A folder in its place, or one that refuses it, is left to the
			// week's sweep, as a mark is; the next file still goes.
		}
	}
}

/**
 * The marks a removal of the call kept at `path` may find: its record
 * alone when it is one this process holds for a call that ran here,
 * since only a hand-off marks one carried.
 */
function marksFound(path: string, ranHere: boolean): readonly string[] {
	if (!ranHere) return [...MARKS];
	return jobRecords.own.has(path) ? [JOB_SUFFIX] : [];
}

/**
 * Remove the marks kept at `path`, those of `mayHold` counted among what
 * an exit takes back until this is past them, answering whether all went.
 */
async function removeMarks(
	path: string,
	mayHold: readonly string[],
): Promise<boolean> {
	const ending = jobRecords.ending.get(path) ?? {
		removals: 0,
		marks: new Set<string>(),
	};
	ending.removals += 1;
	for (const mark of mayHold) ending.marks.add(mark);
	jobRecords.ending.set(path, ending);
	try {
		for (const mark of MARKS) {
			try {
				await rm(`${path}${mark}`, { force: true });
			} catch {
				// A folder in its place, or one that refuses it: no call leaves
				// either, and its callers between processes have no one to tell;
				// the week's sweep, which says nothing of one it can't remove
				// either, tries it again.
				return false;
			}
		}
		return true;
	} finally {
		ending.removals -= 1;
		if (ending.removals === 0) jobRecords.ending.delete(path);
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
