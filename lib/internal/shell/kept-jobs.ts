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
 * session, its job and what taking it up needs. Every reaper spares a
 * call whose record stands and whose shell has written no exit status
 * (`carriedCalls`, kept.ts), and the session, started again, takes up
 * each of its calls still running, or ended with its status, under the
 * job's own id. The record goes with the call's other files, once its
 * end is said or it is stopped.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, type CarriedShell, isCarriedShell } from "./carried.ts";
import { endOf, JOB_SUFFIX, keptFolder, removeKept } from "./kept.ts";

/** One background bash call, as its session takes it up again. */
export interface KeptJob {
	/** The session holding it, by its id. */
	readonly session: string;
	readonly id: string;
	readonly kind: string;
	readonly label: string;
	readonly toolCallId?: string;
	readonly work: CarriedShell;
}

/** Only the owner reads or writes it, as every kept file. */
const FILE_MODE = 0o600;

/** Write the record of a call handed to a job, replacing one there. */
export function recordKeptJob(job: KeptJob): void {
	try {
		writeFileSync(`${job.work.keep}${JOB_SUFFIX}`, JSON.stringify(job), {
			mode: FILE_MODE,
		});
	} catch {
		// Its files went as it ended: nothing is left to take up.
	}
}

/** Whether a record read back is one this code wrote. */
function isKeptJob(value: unknown): value is KeptJob {
	if (typeof value !== "object" || value === null) return false;
	const { session, id, kind, label, toolCallId, work } = value as Record<
		string,
		unknown
	>;
	return (
		typeof session === "string" &&
		typeof id === "string" &&
		typeof kind === "string" &&
		typeof label === "string" &&
		(toolCallId === undefined || typeof toolCallId === "string") &&
		isCarriedShell(work)
	);
}

/** The record at `file`, or nothing when it is gone or not one. */
function recordAt(file: string): KeptJob | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isKeptJob(parsed) ? parsed : undefined;
	} catch {
		// Removed as its call ended, or cut short as it was written.
		return undefined;
	}
}

/**
 * The calls `session` handed to jobs that it can take up: each still
 * running, or ended with its exit status written. A call whose shell is
 * gone with no status was stopped, or killed outright with no way to
 * say how it ended, so its files go rather than wait for a sweep.
 */
export function keptJobsOf(
	session: string,
	folder: string = keptFolder(),
	there: (pid: number, mark: string) => boolean = alive,
): KeptJob[] {
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
		if (job === undefined || job.session !== session) continue;
		const { keep, pid, mark } = job.work;
		if (endOf(keep) !== undefined || there(pid, mark)) found.push(job);
		else removeKept(keep);
	}
	return found;
}
