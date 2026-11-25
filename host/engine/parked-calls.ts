/**
 * The bash calls a park carried, and the wake once the last one ends.
 *
 * On 22 November at 05:52, 26 of optimus's 78 background conversations,
 * 8.8 GB between them, stayed awake only because a bash call was out:
 * most of them loops waiting on another run's rc, which do nothing for
 * hours but keep a whole pi in memory. A host restart already carries
 * such a call to the next host (carried-shells.ts): the conversation
 * writes it in its log as it stops, and takes it up from there as it
 * resumes, saying its end even when it ended meanwhile. So a park, where
 * the host keeps carried calls alive, now carries them the same way.
 *
 * Nobody would hear such a call end, so the calls a park carried are
 * written beside its wake file, and whoever watches that wake (the host
 * that parked it, the supervisor once its child ends, or the next host)
 * looks at them every `CALLS_LOOK_MS`. Once none still runs it writes
 * the wake file, which wakes the conversation as a message to it would,
 * held as one is while the host drains, and writes it again after
 * `CALLS_WAKE_AGAIN_MS`, doubling each time up to
 * `CALLS_WAKE_AGAIN_MOST_MS`, until the conversation runs, since a wake can be
 * refused or its start fail and nobody else would ask again.
 *
 * Waking is the safe way out of every doubt: a call that is lost, its
 * shell gone with no status, past its time limit, or older than
 * `CALLS_WATCHED_MS`, counts as ended. The conversation takes it up as
 * it resumes and says its end, stops it at its limit, or holds it awake
 * as before. The record goes once the conversation runs again.
 *
 * Each look reads, rolls and writes off the host's thread: on 23
 * November its sync opens of a call's `.end` held the background host's
 * loop 5 s at a time while the disk waited on its own commits.
 */

import { readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	alive,
	CALLS_WATCHED_MS,
	type CarriedShell,
	isCarriedShell,
	provedCall,
	stopCarried,
	withinWatch,
} from "../../lib/internal/shell/carried.ts";
import { endRead, rollIfFullOff } from "../../lib/internal/shell/kept.ts";
import { reap } from "../../lib/internal/shell/reap.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import { isJobsCarried, JOBS_CARRIED } from "../../lib/jobs/host.ts";

/** The file, in a parked conversation's folder, naming the calls its park carried. */
const CALLS_FILE = "carried-calls.json";

/**
 * How often a parked conversation's carried calls are looked at: a few
 * small reads each, and a wake a few seconds late costs nothing.
 */
export const CALLS_LOOK_MS = 5000;

/**
 * How long after a wake for ended calls it is asked again while the
 * conversation still rests: long enough for a start under load (a child
 * took over two minutes on 22 November at 06:14), short enough that a
 * refused wake costs minutes, not the night.
 */
export const CALLS_WAKE_AGAIN_MS = 5 * 60 * 1000;

/**
 * The longest a re-asked wake waits: each wait doubles from
 * `CALLS_WAKE_AGAIN_MS`, so a start that fails every time costs a try
 * an hour, not one each five minutes all night.
 */
export const CALLS_WAKE_AGAIN_MOST_MS = 60 * 60 * 1000;

export { CALLS_WATCHED_MS };

/**
 * Whether a carried call's shell still runs, as the call it was, within
 * its time limit and `CALLS_WATCHED_MS` of its start, its end read off
 * the thread.
 */
export async function callRuns(
	work: CarriedShell,
	now: number = Date.now(),
): Promise<boolean> {
	if (!withinWatch(work, now)) return false;
	return (await endRead(work.keep)) === undefined && alive(work.pid, work.mark);
}

/**
 * The calls a park of the conversation in `folder` carried, none when
 * it wrote none. A record there that can't be read or parsed throws:
 * it may name calls, and only waking settles that.
 */
export function carriedCalls(folder: string): CarriedShell[] {
	let text: string;
	try {
		text = readFileSync(join(folder, CALLS_FILE), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	const read: unknown = JSON.parse(text);
	if (!Array.isArray(read))
		throw new Error(`${join(folder, CALLS_FILE)} names no list of calls`);
	return read.filter(isCarriedShell);
}

/** Add `calls` to those a park of the conversation in `folder` carried. */
export function keepCarriedCalls(
	folder: string,
	calls: readonly CarriedShell[],
): void {
	if (calls.length === 0) return;
	writeWhole(
		join(folder, CALLS_FILE),
		`${JSON.stringify([...carriedCalls(folder), ...calls])}\n`,
	);
}

/** Forget the calls a park carried, as the conversation runs and takes them up. */
export function forgetCarriedCalls(folder: string): void {
	rmSync(join(folder, CALLS_FILE), { force: true });
}

/**
 * Stop the calls a park of the conversation in `folder` carried and
 * forget them, as it closes for good: nobody would take them up. A
 * call's group is killed only where its pid is proved still the call
 * (`proved`); otherwise only what carries its mark goes, since the
 * record outlives the call and its pid may lead anyone's group now.
 */
export function stopCarriedCalls(
	folder: string,
	proved: (pid: number, mark: string) => boolean = provedCall,
): void {
	for (const work of carriedCalls(folder)) {
		if (proved(work.pid, work.mark)) stopCarried(work);
		else reap(work.mark);
	}
	forgetCarriedCalls(folder);
}

/**
 * Hear the bash calls a conversation's bus says it carried while
 * `parking` says it parks, handing them to `keep`; a move's or a
 * restart's carry is another's to watch. Answers the disposer.
 */
export function hearParkCarry(
	bus: { on(channel: string, listener: (data: unknown) => void): () => void },
	parking: () => boolean,
	keep: (calls: readonly CarriedShell[]) => void,
): () => void {
	return bus.on(JOBS_CARRIED, (data) => {
		if (!parking() || !isJobsCarried(data)) return;
		const calls = data.jobs
			.map((job) => job.work)
			.filter((work): work is CarriedShell => isCarriedShell(work));
		if (calls.length > 0) keep(calls);
	});
}

/** What watching a parked conversation's carried calls needs. */
export interface CallsWatch {
	/** Its folder, where its park wrote the calls. */
	readonly folder: string;
	/** Its wake file, written once the last call ends. */
	readonly wakeFile: string;
	readonly runs?: (work: CarriedShell) => boolean | Promise<boolean>;
	readonly lookEveryMs?: number;
	readonly wakeAgainMs?: number;
	readonly now?: () => number;
	readonly report: (error: unknown) => void;
	/**
	 * Said once, as the calls are first seen ended: how many, or none
	 * where its record couldn't be read, which wakes it all the same.
	 */
	readonly ended?: (calls: number) => void;
	/**
	 * Calls known without a record, one that couldn't be written: they
	 * count as ended at once, so the conversation wakes and holds them.
	 */
	readonly unrecorded?: readonly CarriedShell[];
	/** Asked once each time the wake file can't be written, after several looks ran fine. */
	readonly unwritten?: () => void;
}

/**
 * Look at the calls a conversation's park carried, rolling their output
 * as the conversation would, until none still runs; then write its wake
 * file, and again after `wakeAgainMs`, each wait twice the last up to
 * `CALLS_WAKE_AGAIN_MOST_MS`, until stopped. A look still out when the
 * next falls due lets it pass, and one out as the watch stops rolls and
 * writes nothing more once it sees the stop, since the woken
 * conversation rolls its calls itself, though a write already under way
 * lands, which costs one wake at most. A look or a write that fails is
 * tried at the next look, reported only as it first fails. Any doubt wakes:
 * a record that can't be read, or calls with none (`unrecorded`), count
 * as ended. Answers the function that stops looking; nothing is looked
 * at where its park carried none.
 */
export function watchCarriedCalls(watch: CallsWatch): () => void {
	let calls: readonly CarriedShell[];
	let doubt = false;
	try {
		calls = watch.unrecorded ?? carriedCalls(watch.folder);
	} catch (error) {
		watch.report(error);
		calls = [];
		doubt = true;
	}
	if (calls.length === 0 && !doubt) return () => {};
	const runs =
		watch.unrecorded !== undefined
			? () => false
			: (watch.runs ?? ((work: CarriedShell) => callRuns(work)));
	const now = watch.now ?? Date.now;
	let wait = watch.wakeAgainMs ?? CALLS_WAKE_AGAIN_MS;
	let nextAt = Number.NEGATIVE_INFINITY;
	let failing = false;
	let lookFailing = false;
	let said = false;
	let looking = false;
	let stopped = false;
	const look = async () => {
		const running: CarriedShell[] = [];
		for (const work of calls) if (await runs(work)) running.push(work);
		const owns = () => !stopped;
		for (const work of running) {
			if (!owns()) return;
			await rollIfFullOff(work.keep, undefined, owns);
		}
		if (stopped || running.length > 0) return;
		if (!said) watch.ended?.(calls.length);
		said = true;
		// One reading for the look, so the next wake is timed from when this
		// one was asked, however long the write takes.
		const at = now();
		if (at < nextAt) return;
		try {
			await writeFile(
				watch.wakeFile,
				`${JSON.stringify({ why: "the bash calls its park carried ended", at: new Date(at).toISOString() })}\n`,
			);
		} catch (error) {
			// Stopped as it wrote: the conversation runs, or is gone, and
			// asking its wake straight would reach one no longer parked.
			if (stopped) return;
			if (!failing) {
				watch.report(error);
				watch.unwritten?.();
			}
			failing = true;
			return;
		}
		failing = false;
		nextAt = at + wait;
		wait = Math.min(wait * 2, CALLS_WAKE_AGAIN_MOST_MS);
	};
	const lookOnce = () => {
		if (looking) return;
		looking = true;
		look()
			.then(
				() => {
					lookFailing = false;
				},
				(error: unknown) => {
					// A fault of the moment fails every look until it passes, and
					// one line says it.
					if (!lookFailing) watch.report(error);
					lookFailing = true;
				},
			)
			.finally(() => {
				looking = false;
			});
	};
	lookOnce();
	const timer = setInterval(lookOnce, watch.lookEveryMs ?? CALLS_LOOK_MS);
	timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
