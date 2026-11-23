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
 * and a session's close takes back the records it still holds first,
 * so no reaper spares what the close stops; one it handed on stays its
 * taker's.
 *
 * A call that ends on its own takes its record back as it settles, and
 * most calls never wrote one: asking the disk, on the loop a host's
 * conversations share, for a name that isn't there held that loop up to
 * 12 s under load. So the process keeps which records it wrote
 * (kept.ts), and a call it wrote none for asks nothing; one it wrote is
 * removed off the thread, set aside first, so a hand-off while it goes
 * can put it back. A call this pi stopped or timed out leaves its record
 * to its files' removal, waiting on nothing. Writing a record, and a
 * session's close taking back those it holds, stay on the thread: the
 * close must take them back before it stops their jobs, and only calls
 * handed to a job have records, so a hold naming a `.job` file can still
 * come from either.
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
	endJobRecordRemoval,
	endOf,
	handJobRecordOn,
	JOB_SUFFIX,
	type JobRecordRemoval,
	keptFolder,
	ownJobRecord,
	ownsJobRecord,
	processThere,
	removeKept,
	removingUnhanded,
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

/** Open a staged name only to make it, never through what is there. */
const NEW_ONLY = "wx";

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
	/**
	 * The call's stop: once it lands the wait ends, saying nothing, as the
	 * call's files then go with its record, and the person asked for it.
	 */
	readonly signal?: AbortSignal;
}

/**
 * Write the record of a call handed to a job, replacing one there, whole
 * so a reader never takes up half of one: written under a name of this
 * write's own beside it and renamed into place. Not through the kept
 * folder's `.writing`, which would stay there once every call's files
 * went; one left by a pi that died mid-write goes with the week's sweep.
 * A record the disk won't take is said, since a pi gone before its call
 * ends then leaves nothing for its next start to take up.
 */
export function recordKeptJob(job: KeptJob): void {
	const file = `${job.work.keep}${JOB_SUFFIX}`;
	const staged = `${file}.${process.pid}.new`;
	const record = JSON.stringify(job);
	try {
		try {
			writeFileSync(staged, record, { mode: FILE_MODE, flag: NEW_ONLY });
		} catch (error) {
			if (!isTaken(error)) throw error;
			// One left by a write that died, or put there by whatever can write
			// the folder: taken away, not written through.
			clearStaged(staged);
			try {
				writeFileSync(staged, record, { mode: FILE_MODE, flag: NEW_ONLY });
			} catch (again) {
				if (!isTaken(again)) throw again;
				throw new Error(`${staged} was taken again as it was written`);
			}
		}
		renameSync(staged, file);
		ownJobRecord(job.work.keep, record);
	} catch (error) {
		clearStaged(staged);
		// The kept folder is gone, which only a hand outside this code does:
		// nothing is left to take up or say.
		if (isMissing(error)) return;
		const why = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`[shell] couldn't record ${file}: ${why}; a pi gone before the call ends leaves it unsaid\n`,
		);
	}
}

/**
 * Take away what a record's write left at `staged`, throwing nothing: a
 * write that couldn't record its call says so, and a throw would leave
 * its recorder unsaid.
 */
function clearStaged(staged: string): void {
	try {
		rmSync(staged, { force: true });
	} catch {
		// A folder at the name, or a disk refusing it: the write after it
		// finds the name taken again, or the record is said unwritten, and
		// the week's sweep tries the name again.
	}
}

/**
 * Take back the record of the call kept at `keep`, leaving it unspared,
 * when this process holds one: a session's close takes back every call
 * it recorded, nearly all gone with their files since, and one handed
 * on is its taker's. A move hands its calls on and closes the session
 * in one turn, so a removal still running for a call it handed is left
 * to put the record back for the taker. One running for a call not
 * handed on, its rename still waiting on the disk, is beaten to it here:
 * the close stops the call's job next and its pi may exit, leaving the
 * record beside the call's end for the next start to say again.
 *
 * Whether this process holds the record is asked by path, not by which
 * session wrote it: a taker in this process that wrote it again before
 * the giver closed would lose it here. None can, since a call is taken
 * up only at a later session's start, after the giver's close.
 */
export function forgetKeptJob(keep: string): void {
	const held = takeJobRecord(keep) !== undefined;
	if (!(held || removingUnhanded(keep))) return;
	try {
		rmSync(`${keep}${JOB_SUFFIX}`, { force: true });
	} catch {
		// Only something other than a file holds the name (force answers a
		// missing one), which nothing here writes. It runs in a session's
		// close, where a throw would skip closing its jobs, leaving them
		// running; left there, it reads as no record, so nothing takes the
		// call up.
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
	const { signal } = options;
	let hear: (() => void) | undefined;
	const stopped = new Promise<"stopped">((done) => {
		hear = () => done("stopped");
		if (signal?.aborted) hear();
		else signal?.addEventListener("abort", hear, { once: true });
	});
	// The call's signal can be its whole run's, so its listener comes off
	// however the race ends, a rejection included.
	let ended: "removed" | "waited" | "stopped";
	try {
		ended = await Promise.race([
			going.then(() => "removed" as const),
			waited,
			stopped,
		]);
	} finally {
		clearTimeout(timer);
		if (hear) signal?.removeEventListener("abort", hear);
	}
	if (ended === "waited") {
		process.stderr.write(
			`[shell] still removing ${keep}${JOB_SUFFIX} after ${waitMs} ms; its call settles without it, and ${whatFollows(keep, removal)}\n`,
		);
	}
}

/**
 * What follows from a removal of the record kept at `keep` still going
 * as its call settles, from where the record stands now: a call handed
 * on is its taker's to record, unless its files went since, as a move
 * that couldn't be written removes them; a record at its name again is
 * one a pi gone meanwhile would take up, and one set aside no start
 * reads.
 */
function whatFollows(keep: string, removal: JobRecordRemoval): string {
	if (removal.gone)
		return "the call's files went meanwhile, so nothing takes it up";
	if (removal.handed)
		return "the call was handed on meanwhile, so a pi gone before its taker records it leaves the call to strays";
	if (removal.setAside && !ownsJobRecord(keep))
		return "it is set aside already, where no start reads it";
	return "a pi gone before it goes may say the call's end again";
}

/**
 * Remove this process's record of the call kept at `keep` while it is
 * this process's. Each pass renames it aside before removing it, since a
 * rename or unlink the disk has yet to reach can't be called back. A
 * hand-off meanwhile puts the record back for its taker, linked rather
 * than renamed so it never replaces one the taker wrote first: what was
 * set aside, when the hand-off came before the rename landed, since a
 * taker's write may have been what it moved, and kept there when the
 * disk refuses the link; otherwise, once the aside is gone, what this
 * process wrote last. Nothing is put back once the call's files went, as
 * a taker in this process that ended the call removed them, or a move
 * that couldn't be written did as it stopped the call; a taker in
 * another process that ends the call while the disk holds the put-back
 * can leave a record a later start says the end of again.
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
			await removeOnce(file, aside, record, removal);
		} finally {
			// Timed whichever way the pass ended: a slow refusal is as telling.
			const took = now() - began;
			if (took > SLOW_REMOVAL_MS) {
				process.stderr.write(`[shell] removing ${file} took ${took} ms\n`);
			}
		}
	}
}

/** One pass of `removeOwn`: `record` at `file`, set aside and removed. */
async function removeOnce(
	file: string,
	aside: string,
	record: string,
	removal: JobRecordRemoval,
): Promise<void> {
	try {
		await rename(file, aside);
	} catch (error) {
		// Gone already, with the call's other files: nothing to remove.
		if (isMissing(error)) return;
		// A disk refusing it (read-only after an error, failing, or the
		// file made immutable): the record stays, and `removeKept` just
		// after stops at it. Said, since nothing else would show it.
		sayStays(file, error);
		return;
	}
	const handedFirst = removal.handed;
	removal.setAside = !handedFirst;
	const linkAside = () => link(aside, file);
	if (handedFirst && !(await putBack(file, removal, linkAside, aside))) return;
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
		await putBack(file, removal, () =>
			writeBack(file, removal.latest ?? record),
		);
	removal.setAside = false;
}

/**
 * Put a record back for the call's taker by `linking` it into place,
 * which leaves one the taker wrote there already, the newer; not once
 * the call's files went, and taken away again when they went as it
 * landed, since a record beside the call's end has a start say it again.
 * Answers whether the record stands settled: false only when the disk
 * refused the link, said with what it came `from`, which stays.
 */
async function putBack(
	file: string,
	removal: JobRecordRemoval,
	linking: () => Promise<void>,
	from?: string,
): Promise<boolean> {
	if (removal.gone) return true;
	try {
		await linking();
	} catch (error) {
		if (isTaken(error)) return true;
		sayNotBack(file, error, from);
		return false;
	}
	if (removal.gone)
		await rm(file, { force: true }).catch((error) => sayStays(file, error));
	return true;
}

/**
 * Write `record` back under a name of its own, whole, and link it into
 * place, rejecting as the link does.
 */
async function writeBack(file: string, record: string): Promise<void> {
	const staged = `${file}.${process.pid}.back`;
	try {
		await writeStaged(staged, record);
		await link(staged, file);
	} finally {
		await rm(staged, { force: true }).catch(() => {
			// Under a name no start reads as a record; the week's sweep takes it.
		});
	}
}

/**
 * Write `record` under `staged`, a name no one else's, refusing to write
 * through whatever is there already, as a link left there would have it;
 * what is there is taken away and the write tried again. A name taken
 * again by then is a refusal of the write, never read as the taker's
 * record, which only the link into place can find.
 */
async function writeStaged(staged: string, record: string): Promise<void> {
	try {
		await writeFile(staged, record, { mode: FILE_MODE, flag: NEW_ONLY });
	} catch (error) {
		if (!isTaken(error)) throw error;
		await rm(staged, { force: true });
		try {
			await writeFile(staged, record, { mode: FILE_MODE, flag: NEW_ONLY });
		} catch (again) {
			if (!isTaken(again)) throw again;
			throw new Error(`${staged} was taken again as it was written`);
		}
	}
}

/**
 * Say that `file` couldn't be put back for its call's taker, and what
 * follows; what it would have come `from`, when that stays.
 */
function sayNotBack(file: string, error: unknown, from?: string): void {
	const why = error instanceof Error ? error.message : String(error);
	const stays = from === undefined ? "" : `; it stays set aside at ${from}`;
	process.stderr.write(
		`[shell] couldn't put ${file} back for the call's taker: ${why}${stays}; a pi gone before the taker records it leaves the call to strays\n`,
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
