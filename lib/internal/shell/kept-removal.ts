/**
 * How a bash call's kept files go (kept.ts): removing them as the call
 * ends, the job records this process wrote and hands on (kept-jobs.ts),
 * and what an exit takes back that its disk had yet to remove.
 *
 * Removals go through libuv's pool rather than pi's loop, which in a
 * host every conversation shares, so a removal takes turns of the loop:
 * it removes the marks that would have a call taken up again before its
 * status, and a pi ended partway through leaves no call that reads as
 * running. A call handed on meanwhile has its record put back for its
 * taker, and an exit takes back on the thread what its pool had yet to
 * do, since no answer of the pool's is heard once the process exits.
 */

import { existsSync, linkSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { count, noun } from "../../ui/count.ts";
import { processGlobal } from "../process/process-global.ts";
import { JOB_SUFFIX } from "./kept.ts";

/**
 * Every file a call keeps, in the order they are removed: the marks that
 * have it taken up again first, then its status, so a removal cut short
 * leaves no call that reads as running. A carried call taken up has both
 * marks, and one cut between them can still have its end said again.
 */
const SUFFIXES = [".job", ".carried", ".end", ".pid", ".out", ".old"] as const;

/** The suffixes that have a call taken up again. */
const MARKS: ReadonlySet<string> = new Set([".job", ".carried"]);

/**
 * The name a removal in this process sets the record at `file` aside
 * under, off its name: this process's alone, which no start reads.
 */
export function asideOf(file: string): string {
	return `${file}.${process.pid}.gone`;
}

/**
 * The name a removal in this process stages a put-back of the record at
 * `file` under: this process's alone, which no start reads.
 */
export function stagedBackOf(file: string): string {
	return `${file}.${process.pid}.back`;
}

/** Whether `error` says the name it was asked about isn't there. */
export function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Whether `error` says the name it would make is taken already. */
export function isTaken(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
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
	/**
	 * Where its record is renamed to off its name, from when the rename is
	 * asked until the removal has removed it there: a hand-off before then
	 * is put back from it.
	 */
	aside?: string;
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
 * process exits, since no answer of its pool's is heard once it has, so
 * nothing after one runs, and a record or carried mark left would stand beside the call's end for its
 * next start to say again: the record of each removal still running
 * for a call not handed on, or whose files went, as one put back for a
 * taker can land after they did, and the marks of each call
 * `removeKept` may find and has yet to get past. Only an exit does it, never a
 * session's close, since in a host the process lives on and the disk
 * gets to them off the thread; a pi killed outright runs nothing, and
 * its next start says the call's end again. Each waits on the disk that
 * left it, so how many names it asks after is said first, for a slow
 * exit to be read by: up to that many, since a mark may never have been
 * written. A call handed on mid-removal has its record put back for its
 * taker from where it was set aside, the pool's own put-back going with
 * the process; one the removal had removed already, its put-back yet to
 * land, is said, since its call then has no record until its taker
 * writes one, and a pi gone first leaves it to the week's strays. What
 * the pool was asked before the exit it still does after, its answer
 * never heard: a handed call whose files went has what its put-back
 * links from taken first, so a link landing after finds nothing.
 */
function takeRecordsBack(): void {
	const removals = [...jobRecords.removing];
	const records = removals
		.filter(([, removal]) => !removal.handed || removal.gone)
		.map(([path]) => `${path}${JOB_SUFFIX}`);
	const sources = removals
		.filter(([, removal]) => removal.handed && removal.gone)
		.flatMap(([path]) => {
			const file = `${path}${JOB_SUFFIX}`;
			return [asideOf(file), stagedBackOf(file)];
		});
	const handed = removals.filter(
		([, removal]) => removal.handed && !removal.gone,
	);
	const marks = [...jobRecords.ending].flatMap(([path, ending]) =>
		[...ending.marks].map((mark) => `${path}${mark}`),
	);
	const files = [...new Set([...sources, ...records, ...marks])];
	if (files.length > 0) {
		sayAtExit(
			`[shell] taking back up to ${count(files.length, "kept file")} the disk had yet to remove as pi exits\n`,
		);
	}
	for (const file of files) unlinkNow(file);
	const unrecorded = handed.filter(
		([path, removal]) => !putBackNow(`${path}${JOB_SUFFIX}`, removal.aside),
	).length;
	if (unrecorded > 0) {
		sayAtExit(
			`[shell] ${count(unrecorded, "call")} handed on as pi exits ${noun(unrecorded, "has", "have")} no record put back, until ${noun(unrecorded, "its taker writes one", "their takers write theirs")}\n`,
		);
	}
}
jobRecords.takeBack = takeRecordsBack;

/** Say `text` as the process exits, if anything still reads what it says. */
function sayAtExit(text: string): void {
	try {
		process.stderr.write(text);
	} catch {
		// Its error output gone with whatever read it; the files still go.
	}
}

/**
 * How often the exit tries to put a record back: twice, so a rename
 * landing between its two links is found by the second.
 */
const PUT_BACK_TRIES = 2;

/**
 * Put a handed call's record back at `file` from where it was set
 * `aside`, on the thread as the process exits, answering whether a
 * record stands there now: the taker's own, written first, stays. With
 * nothing set aside, the rename may yet land, the pool finishing it
 * after the exit, so a record still at its name is linked to the aside
 * too: a rename from one name of a file to another of it does nothing,
 * and the record stays where its taker reads it, a second name beside
 * it for the week's sweep. A rename landing between the two links is
 * found by the next try.
 */
function putBackNow(file: string, aside: string | undefined): boolean {
	if (aside === undefined) return existsSync(file);
	for (let tries = 0; tries < PUT_BACK_TRIES; tries++) {
		try {
			linkSync(aside, file);
			unlinkNow(aside);
			return true;
		} catch (error) {
			// Taken already, by the taker's own or the pool's put-back.
			if (isTaken(error)) {
				unlinkNow(aside);
				return true;
			}
			if (!isMissing(error)) return existsSync(file);
		}
		// Nothing set aside: its rename has yet to land, or its removal has.
		try {
			linkSync(file, aside);
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			if (!isTaken(error)) return existsSync(file);
		}
	}
	return existsSync(file);
}

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
 * but for a call `neverHanded`, whose only mark can be the record this
 * process holds for it, so an exit on a slow disk asks after no name
 * its call never wrote.
 */
export async function removeKept(
	path: string,
	{
		neverHanded = false,
	}: {
		/**
		 * The call was started by this process and never handed on, so
		 * nothing marked it carried. False for any call ever marked carried,
		 * one taken up from another process included, since its exit would
		 * then leave the mark beside the call's end.
		 */
		neverHanded?: boolean;
	} = {},
): Promise<void> {
	const mayHold = marksFound(path, neverHanded);
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
 * alone when it is one this process holds for a call never handed on,
 * since only a hand-off marks one carried.
 */
function marksFound(path: string, neverHanded: boolean): readonly string[] {
	if (!neverHanded) return [...MARKS];
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
