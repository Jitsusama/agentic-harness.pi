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
 * held as one is while the host drains. A call that is lost, its shell
 * gone with no status, counts as ended: the conversation says so as it
 * takes it up. The record goes once the conversation runs again.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	alive,
	type CarriedShell,
	isCarriedShell,
} from "../../lib/internal/shell/carried.ts";
import { endOf } from "../../lib/internal/shell/kept.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import { isJobsCarried, JOBS_CARRIED } from "../../lib/jobs/host.ts";

/** The file, in a parked conversation's folder, naming the calls its park carried. */
const CALLS_FILE = "carried-calls.json";

/**
 * How often a parked conversation's carried calls are looked at: a few
 * small reads each, and a wake a few seconds late costs nothing.
 */
export const CALLS_LOOK_MS = 5000;

/** Whether a carried call's shell still runs, as the call it was. */
export function callRuns(work: CarriedShell): boolean {
	return endOf(work.keep) === undefined && alive(work.pid, work.mark);
}

/** The calls a park of the conversation in `folder` carried, none when it carried none. */
export function carriedCalls(folder: string): CarriedShell[] {
	try {
		const read: unknown = JSON.parse(
			readFileSync(join(folder, CALLS_FILE), "utf8"),
		);
		return Array.isArray(read) ? read.filter(isCarriedShell) : [];
	} catch {
		// No file: its park carried nothing, or it ran since.
		return [];
	}
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
	readonly runs?: (work: CarriedShell) => boolean;
	readonly lookEveryMs?: number;
	readonly report: (error: unknown) => void;
}

/**
 * Look at the calls a conversation's park carried until none still
 * runs, then write its wake file once. Answers the function that stops
 * looking; nothing is looked at where its park carried none.
 */
export function watchCarriedCalls(watch: CallsWatch): () => void {
	const calls = carriedCalls(watch.folder);
	if (calls.length === 0) return () => {};
	const runs = watch.runs ?? callRuns;
	const look = (): boolean => {
		if (calls.some(runs)) return false;
		try {
			writeFileSync(
				watch.wakeFile,
				`${JSON.stringify({ why: "the bash calls its park carried ended", at: new Date().toISOString() })}\n`,
			);
		} catch (error) {
			watch.report(error);
		}
		return true;
	};
	if (look()) return () => {};
	const timer = setInterval(() => {
		if (look()) clearInterval(timer);
	}, watch.lookEveryMs ?? CALLS_LOOK_MS);
	timer.unref();
	return () => clearInterval(timer);
}
