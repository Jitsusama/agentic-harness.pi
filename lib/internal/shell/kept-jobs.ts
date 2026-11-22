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
 * the process keeps which records it wrote (kept.ts), and a call it
 * wrote none for asks nothing; one it wrote is removed off the thread,
 * set aside first, so a hand-off while it goes can put it back.
 */

import {
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { link, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alive, type CarriedShell, isCarriedShell } from "./carried.ts";
import {
	beginJobRecordRemoval,
	disownJobRecord,
	endJobRecordRemoval,
	endOf,
	handJobRecordOn,
	JOB_SUFFIX,
	type JobRecordRemoval,
	keptFolder,
	ownJobRecord,
	processThere,
	removeKept,
	takeJobRecord,
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

/**
 * How long a record's removal may run before it is said: a disk this
 * slow is one a host's journal should show, since the removal is off the
 * thread now and holds no loop a watcher would see.
 */
const SLOW_REMOVAL_MS = 1_000;

/**
 * How long a call waits for its record's removal before it settles
 * anyway: a wedged disk would otherwise hold the call open with no end.
 */
const REMOVAL_WAIT_MS = 5_000;

/** What the final removal of a call's own record may be told. */
export interface ForgetOwnOptions {
	/** How long to wait for the disk before settling without it. */
	readonly waitMs?: number;
	/** The clock a removal's time is read from. */
	readonly now?: () => number;
}

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
	const record = JSON.stringify(job);
	try {
		writeFileSync(staged, record, { mode: FILE_MODE });
		renameSync(staged, file);
		ownJobRecord(job.work.keep, record);
	} catch {
		// Its files went as it ended: nothing is left to take up.
		rmSync(staged, { force: true });
	}
}

/** Take back the record of the call kept at `keep`, leaving it unspared. */
export function forgetKeptJob(keep: string): void {
	disownJobRecord(keep);
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
 * the disk. A record written again while the removal runs, as a
 * rollover's recorder does, is removed in turn, unless the call was
 * handed on meanwhile, when the record is its taker's. Waits at most
 * `waitMs`, saying so, the removal going on behind. Never rejects, as
 * `forgetKeptJob` never throws: it runs in a call's finally, where a
 * rejection would stand in for the call's own outcome.
 */
export async function forgetOwnKeptJob(
	keep: string,
	options: ForgetOwnOptions = {},
): Promise<void> {
	const removal = beginJobRecordRemoval(keep);
	if (removal === undefined) return;
	const waitMs = options.waitMs ?? REMOVAL_WAIT_MS;
	const going = removeOwn(keep, removal, options.now ?? Date.now).finally(() =>
		endJobRecordRemoval(keep, removal),
	);
	let timer: NodeJS.Timeout | undefined;
	const waited = new Promise<"waited">((done) => {
		timer = setTimeout(() => done("waited"), waitMs);
		timer.unref();
	});
	const ended = await Promise.race([
		going.then(() => "removed" as const),
		waited,
	]);
	clearTimeout(timer);
	if (ended === "waited") {
		// Once set aside, no start reads it, so only a removal still to move
		// it leaves a record a pi gone meanwhile would take up again.
		const follows = removal.setAside
			? "it is set aside already, where no start reads it"
			: "a pi gone before it goes may say the call's end again";
		process.stderr.write(
			`[shell] still removing ${keep}${JOB_SUFFIX} after ${waitMs} ms; its call settles without it, and ${follows}\n`,
		);
	}
}

/**
 * Remove this process's record of the call kept at `keep` while it is
 * this process's. Each pass renames it aside before removing it, since a
 * rename or unlink the disk has yet to reach can't be called back. A
 * hand-off meanwhile puts the record back for its taker, linked rather
 * than renamed so it never replaces one the taker wrote first: what was
 * set aside, when the hand-off came before the rename landed, since a
 * taker's write may have been what it moved; otherwise, once the aside
 * is gone, what this process wrote.
 */
async function removeOwn(
	keep: string,
	removal: JobRecordRemoval,
	now: () => number,
): Promise<void> {
	const file = `${keep}${JOB_SUFFIX}`;
	const aside = `${file}.${process.pid}.gone`;
	while (!removal.handed) {
		const record = takeJobRecord(keep);
		if (record === undefined) return;
		const began = now();
		try {
			await rename(file, aside);
		} catch (error) {
			// Gone already, with the call's other files: nothing to remove.
			if (isMissing(error)) continue;
			// A disk refusing it (read-only after an error, failing, or the
			// file made immutable): the record stays, and `removeKept` just
			// after stops at it. Said, since nothing else would show it.
			sayStays(file, error);
			continue;
		}
		const handedFirst = removal.handed;
		removal.setAside = !handedFirst;
		if (handedFirst) await linkBack(aside, file);
		try {
			await rm(aside, { force: true });
		} catch (error) {
			// A disk refusing it: what stays is under a name no start reads
			// as a record, and the week's sweep takes a file left that long.
			const why = error instanceof Error ? error.message : String(error);
			process.stderr.write(
				`[shell] couldn't remove ${aside}: ${why}; no start reads it as a record, and the week's sweep takes it\n`,
			);
		}
		if (removal.handed && !handedFirst)
			await writeBack(file, removal.latest ?? record);
		removal.setAside = false;
		const took = now() - began;
		if (took > SLOW_REMOVAL_MS) {
			process.stderr.write(`[shell] removing ${file} took ${took} ms\n`);
		}
	}
}

/**
 * Put a record set aside back for the call's taker, unless the taker has
 * written its own there already, which is the newer.
 */
async function linkBack(aside: string, file: string): Promise<void> {
	try {
		await link(aside, file);
	} catch (error) {
		if (!isTaken(error)) sayNotBack(file, error);
	}
}

/**
 * Write `record` back for the call's taker once what was set aside is
 * gone, whole, under a name of its own first, and linked into place
 * unless the taker has written its own there already.
 */
async function writeBack(file: string, record: string): Promise<void> {
	const staged = `${file}.${process.pid}.back`;
	try {
		await writeFile(staged, record, { mode: FILE_MODE });
		await link(staged, file);
	} catch (error) {
		if (!isTaken(error)) sayNotBack(file, error);
	} finally {
		await rm(staged, { force: true }).catch(() => {
			// Under a name no start reads as a record; the week's sweep takes it.
		});
	}
}

/** Say that `file` couldn't be put back for its call's taker, and what follows. */
function sayNotBack(file: string, error: unknown): void {
	const why = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		`[shell] couldn't put ${file} back for the call's taker: ${why}; a pi gone before the taker records it leaves the call to strays\n`,
	);
}

/** Say that `file` stays where it is, and what follows from that. */
function sayStays(file: string, error: unknown): void {
	const why = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		`[shell] couldn't remove ${file}: ${why}; it stays, so this pi's next start may say the call's end again\n`,
	);
}

/** Whether `error` says the name it was asked about isn't there. */
function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Whether `error` says the name it would make is taken already. */
function isTaken(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * Let go of the record of the call kept at `keep` as this process's,
 * asking nothing of the disk: the call was handed on, and whoever takes
 * it up records it again and takes it back. A removal of it still
 * running puts back what it set aside.
 */
export function disownKeptJob(keep: string): void {
	handJobRecordOn(keep);
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
