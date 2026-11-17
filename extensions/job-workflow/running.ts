/**
 * Every job a session has running, noted on disk as its registry
 * changes, so a session whose pi or host was killed outright is told
 * which of its jobs ended with it.
 *
 * A signalled end leaves a cut-off record in the log (cut-off.ts), and
 * a log that stops mid-run reads as cut off, but a kill while the
 * session waited on its jobs, its turn ended, leaves a log that reads
 * as idle. On 17 November at 00:07 five hosted conversations came back
 * so, each waiting on jobs that died with the old host (2DZF5Z's j104,
 * 5HJZ8Z's j222 and j223), and sat three and a half hours until a
 * reload, since nothing started a turn.
 *
 * The note names the pi that holds the jobs by its pid and, where procfs
 * says, the second it started, so a session parked and adopted in the
 * same process, whose jobs live on, is told nothing, while a pid reused
 * after a restart or a reboot hides nothing. A hand-off to another
 * runtime, a close for good and a park nobody adopts take the note back.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import { startSecondsFromProcSync } from "../../lib/internal/process-ticks.ts";
import { isRecord } from "../../lib/internal/record.ts";
import type { CutJob } from "../../lib/internal/session/cut-off-record.ts";
import { processThere } from "../../lib/internal/shell/kept.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";

/** Readable by this user alone, as every other session record is. */
const FILE_MODE = 0o600;

/** What a session had running, and the pi that held it. */
export interface RunningNote {
	/** The pi holding the jobs, by its pid. */
	readonly owner: number;
	/**
	 * When that pi started, in seconds since the epoch, where procfs
	 * says; a pid since reused started at another second.
	 */
	readonly started?: number;
	readonly jobs: readonly CutJob[];
}

/** How a process's standing is read, for tests to stand in for. */
export interface Judge {
	readonly there?: (pid: number) => boolean;
	readonly startedOf?: (pid: number) => number | undefined;
}

/** Where sessions note their running jobs, under this package's state. */
export function runningFolder(): string {
	return join(stateDir("job-workflow"), "running");
}

function noteFile(session: string, folder: string): string {
	return join(folder, `${encodeURIComponent(session)}.json`);
}

/** Note what `session` has running, replacing the note there, whole. */
export function noteRunning(
	session: string,
	note: RunningNote,
	folder: string = runningFolder(),
): void {
	try {
		writeWhole(noteFile(session, folder), JSON.stringify(note), {
			mode: FILE_MODE,
		});
	} catch {
		// A note that can't be written is a notice that won't come after a
		// kill, never a job that fails.
	}
}

/** Take back what `session` noted, as its jobs end or are stopped. */
export function forgetRunning(
	session: string,
	folder: string = runningFolder(),
): void {
	removeNote(noteFile(session, folder));
}

function removeNote(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		// A note that can't be removed is at worst one notice too many,
		// never a job's end or a session's start that fails.
	}
}

function isCutJob(value: unknown): value is CutJob {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.label === "string"
	);
}

function noteAt(file: string): RunningNote | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// None noted, or one torn by a disk that filled: nothing to tell.
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const { owner, started, jobs } = value;
	if (typeof owner !== "number" || !Array.isArray(jobs)) return undefined;
	return {
		owner,
		...(typeof started === "number" ? { started } : {}),
		jobs: jobs.filter(isCutJob),
	};
}

/** This process, as a note names it. */
export function thisPi(): Pick<RunningNote, "owner" | "started"> {
	const started = startSecondsFromProcSync(process.pid);
	return { owner: process.pid, ...(started !== undefined ? { started } : {}) };
}

// A pid of 0 or less names a group or every process, never a pi. One whose
// start can't be read now (no procfs, or gone) is judged by its pid alone.
function ownerRuns(note: RunningNote, judge: Judge): boolean {
	const there = judge.there ?? processThere;
	const startedOf = judge.startedOf ?? startSecondsFromProcSync;
	if (!Number.isSafeInteger(note.owner) || note.owner <= 0) return false;
	if (!there(note.owner)) return false;
	if (note.started === undefined) return true;
	const started = startedOf(note.owner);
	return started === undefined || started === note.started;
}

/**
 * What `session` noted running in a pi that has gone, taken back so it
 * is told once; nothing when none was noted or its pi still runs, which
 * holds those jobs yet. Read before the session's own jobs note again.
 */
export function takeEndedNote(
	session: string,
	folder: string = runningFolder(),
	judge: Judge = {},
): RunningNote | undefined {
	const file = noteFile(session, folder);
	const note = noteAt(file);
	if (note === undefined) {
		removeNote(file);
		return undefined;
	}
	if (ownerRuns(note, judge)) return undefined;
	removeNote(file);
	return note;
}

/**
 * The jobs `ended` noted that nothing took up again, which `held` names
 * by id: these alone ended with the pi, and the rest live on.
 */
export function endedJobs(
	ended: RunningNote | undefined,
	held: ReadonlySet<string>,
): readonly CutJob[] {
	return (ended?.jobs ?? []).filter((job) => !held.has(job.id));
}

/** What a session is told of a job that ended with its pi or host. */
export function endedWithHostText(job: CutJob): string {
	return `${job.id} (${job.label}) was running when this session's pi or host was killed, and ended with it: it will never report. Run it again if it still matters. Anything it started outside this machine, such as cloud VMs, may still be running.`;
}
