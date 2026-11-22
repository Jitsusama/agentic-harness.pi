/**
 * The background bash calls a session holds, written beside what each
 * keeps of itself (kept.ts), so the session takes them up again however
 * its pi or its host ended.
 *
 * A move or a host's own restart carries a session's calls through its
 * log (extensions/job-workflow/moved.ts), but only when the session ends
 * as planned. On 17 November a host's stop outran systemd's 60 s and the
 * host was killed, so none of its conversations wrote what it carried,
 * and the next host ended four suites and proofs whose commands still
 * ran. So a call handed to a job writes `<path>.job` as it goes: its
 * session, its job, the pi that holds it and what taking it up needs.
 *
 * Every reaper spares a call whose record stands while its shell runs,
 * within its time limit and a day of its start (`carriedCalls`,
 * kept.ts). The session, started again, takes up each of its calls
 * still running, or ended with its status, under the job's own id, but
 * never one whose pi still runs, which holds it yet. A call no session
 * takes up is stopped by its host's look at strays once its time limit
 * or a day has passed (host/engine/carried-shells.ts). The record goes
 * with the call's other files, once its end is said or it is stopped,
 * and a session's close for good takes its records back first, so no
 * reaper spares what the close stops.
 *
 * Every call takes its record back as it ends, on the loop a host's
 * conversations share, and most calls never wrote one: asking the disk
 * for a name that isn't there held that loop up to 12 s under load. So
 * the process keeps which records it wrote, and a call it wrote none
 * for asks nothing; one it wrote is removed off the thread.
 */

import {
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { processGlobal } from "../process/process-global.ts";
import { alive, type CarriedShell, isCarriedShell } from "./carried.ts";
import {
	endOf,
	JOB_SUFFIX,
	keptFolder,
	processThere,
	removeKept,
} from "./kept.ts";

/** One background bash call, as its session takes it up again. */
export interface KeptJob {
	/** The session holding it, by its id. */
	readonly session: string;
	readonly id: string;
	readonly kind: string;
	readonly label: string;
	readonly toolCallId?: string;
	/** The pi that holds it, by its pid; one that runs still holds it. */
	readonly owner?: number;
	readonly work: CarriedShell;
}

/** Only the owner reads or writes it, as every kept file. */
const FILE_MODE = 0o600;

// The kept paths whose record this process wrote and hasn't taken back,
// for the process rather than a module copy: a reload evaluates this
// module again while calls started before it still run, and a call and
// its recorder may sit in either copy. Each path is a call's own, so
// conversations never share one; the key names the shape.
const ownRecords = processGlobal(
	"agentic-harness.internal/shell/kept-jobs/own-records.v1",
	() => new Set<string>(),
);

/**
 * Write the record of a call handed to a job, replacing one there, whole
 * so a reader never takes up half of one: written under a name of this
 * write's own beside it and renamed into place. Not through the kept
 * folder's `.writing`, which would stay there once every call's files
 * went; one left by a pi that died mid-write goes with the week's sweep.
 */
export function recordKeptJob(job: KeptJob): void {
	const file = `${job.work.keep}${JOB_SUFFIX}`;
	const staged = `${file}.${process.pid}.new`;
	try {
		writeFileSync(staged, JSON.stringify(job), { mode: FILE_MODE });
		renameSync(staged, file);
		ownRecords.add(job.work.keep);
	} catch {
		// Its files went as it ended: nothing is left to take up.
		rmSync(staged, { force: true });
	}
}

/** Take back the record of the call kept at `keep`, leaving it unspared. */
export function forgetKeptJob(keep: string): void {
	ownRecords.delete(keep);
	try {
		rmSync(`${keep}${JOB_SUFFIX}`, { force: true });
	} catch {
		// Only something other than a file holds the name (force answers a
		// missing one), which nothing here writes. It runs in a call's
		// finally, where a throw would stand in for the call's own outcome;
		// left there, it reads as no record, so nothing takes the call up.
	}
}

/**
 * Take back the record of the call kept at `keep` when this process
 * wrote one, off the thread; a call it wrote none for asks nothing of
 * the disk. Never rejects, as `forgetKeptJob` never throws: it runs in
 * a call's finally, where a rejection would stand in for the call's own
 * outcome.
 */
export async function forgetOwnKeptJob(keep: string): Promise<void> {
	if (!ownRecords.delete(keep)) return;
	try {
		await rm(`${keep}${JOB_SUFFIX}`, { force: true });
	} catch {
		// Only something other than a file holds the name, which nothing
		// here writes; left there, it reads as no record.
	}
}

/** Whether a record read back is one this code wrote. */
function isKeptJob(value: unknown): value is KeptJob {
	if (typeof value !== "object" || value === null) return false;
	const { session, id, kind, label, toolCallId, owner, work } = value as Record<
		string,
		unknown
	>;
	return (
		typeof session === "string" &&
		typeof id === "string" &&
		typeof kind === "string" &&
		typeof label === "string" &&
		(toolCallId === undefined || typeof toolCallId === "string") &&
		(owner === undefined || typeof owner === "number") &&
		isCarriedShell(work)
	);
}

/** The record at `file`, or nothing when it is gone or not one. */
function recordAt(file: string): KeptJob | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isKeptJob(parsed) ? parsed : undefined;
	} catch {
		// Removed as its call ended.
		return undefined;
	}
}

/** Whether the pi that recorded `job` has gone, so nothing holds it. */
function unheld(job: KeptJob, there: (pid: number) => boolean): boolean {
	return job.owner === undefined || !there(job.owner);
}

/** Every record in `folder` that reads back, by the call's kept path. */
function recordsIn(folder: string): KeptJob[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder yet: nothing was ever kept.
		return [];
	}
	const found: KeptJob[] = [];
	for (const name of names) {
		if (!name.endsWith(JOB_SUFFIX)) continue;
		const job = recordAt(join(folder, name));
		if (job !== undefined) found.push(job);
	}
	return found;
}

/**
 * The calls `session` handed to jobs that it can take up: each still
 * running, or ended with its exit status written, whose pi has gone. A
 * call whose shell is gone with no status was stopped, or killed
 * outright with no way to say how it ended, so its files go rather than
 * wait for a sweep.
 */
export function keptJobsOf(
	session: string,
	folder: string = keptFolder(),
	there: (pid: number, mark: string) => boolean = alive,
	owner: (pid: number) => boolean = processThere,
): KeptJob[] {
	const found: KeptJob[] = [];
	for (const job of recordsIn(folder)) {
		if (job.session !== session || !unheld(job, owner)) continue;
		const { keep, pid, mark } = job.work;
		if (endOf(keep) !== undefined || there(pid, mark)) found.push(job);
		// Left to run: nothing waits on files nobody will take up.
		else void removeKept(keep);
	}
	return found;
}

/**
 * The recorded calls whose pi has gone and whose end is not yet said:
 * the ones a host looks at to stop, once nobody takes them up in time.
 */
export function strayKeptJobs(
	folder: string = keptFolder(),
	owner: (pid: number) => boolean = processThere,
): KeptJob[] {
	return recordsIn(folder).filter(
		(job) => unheld(job, owner) && endOf(job.work.keep) === undefined,
	);
}
