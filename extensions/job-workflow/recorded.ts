/**
 * Each running bash job of a session, recorded beside what its call
 * keeps on disk (lib/internal/shell/kept-jobs.ts), so the session takes
 * it up again when its pi or its host is killed outright, which carries
 * nothing through the log.
 *
 * A job's work is asked for each time the registry changes. A call
 * handed off the moment it started may not have written its shell's pid
 * yet, and has nothing to record until it has, so one not yet
 * recordable is asked again a second on, for a minute at most.
 *
 * Started again, the session takes up each recorded call still running,
 * or ended with its status, that nothing else has taken up
 * (`recordedCarry`), as a move's would be (moved.ts).
 */

import { isCarriedShell } from "../../lib/internal/shell/carried.ts";
import {
	type KeptJob,
	keptJobsOf,
	recordKeptJob,
} from "../../lib/internal/shell/kept-jobs.ts";
import type { Jobs } from "./jobs.ts";
import type { Carried } from "./moved.ts";

/** How long to wait before asking a job not yet recordable again. */
const RECORD_AGAIN_MS = 1000;

/** How many times a job not yet recordable is asked, a second apart. */
export const MOST_ASKS = 60;

/** What records a session's jobs. */
export interface JobRecorder {
	/** The registry changed: record what is running and not yet recorded. */
	changed(): void;
	/** Stop asking again. */
	stop(): void;
}

/** How a recorder writes and waits, for tests to stand in for. */
interface RecorderOptions {
	readonly write?: (job: KeptJob) => void;
	readonly later?: (ms: number, run: () => void) => () => void;
}

/**
 * The calls `session` recorded that it can take up and doesn't hold, as
 * a carry taken up `at`; nothing when there are none. `held` are the ids
 * already taken up, from a move's log above all.
 */
export function recordedCarry(
	session: string,
	held: ReadonlySet<string>,
	at: number,
	read: (session: string) => readonly KeptJob[] = keptJobsOf,
): Carried | undefined {
	const jobs = read(session)
		.filter((job) => !held.has(job.id))
		.map(({ id, kind, label, toolCallId, work }) => ({
			id,
			kind,
			label,
			...(toolCallId !== undefined ? { toolCallId } : {}),
			work,
		}));
	return jobs.length === 0 ? undefined : { at, jobs, results: [] };
}

/** Ask again once, `ms` on, without holding the process open. */
function laterOnce(ms: number, run: () => void): () => void {
	const timer = setTimeout(run, ms);
	timer.unref();
	return () => clearTimeout(timer);
}

/**
 * Record the running bash jobs of `jobs()` for `session`, each once. A
 * session with no id can't be found again, so nothing is recorded.
 */
export function recordJobs(
	jobs: () => Pick<Jobs, "list"> | undefined,
	session: () => string | undefined,
	options: RecorderOptions = {},
): JobRecorder {
	const write = options.write ?? recordKeptJob;
	const later = options.later ?? laterOnce;
	const recorded = new Set<string>();
	const asked = new Map<string, number>();
	let cancel: (() => void) | undefined;

	const record = () => {
		cancel = undefined;
		const id = session();
		const held = jobs();
		if (id === undefined || held === undefined) return;
		let waiting = false;
		for (const job of held.list()) {
			if (job.state !== "running" || !job.spec.carry) continue;
			if (recorded.has(job.id)) continue;
			const work = job.spec.carry.what();
			if (isCarriedShell(work)) {
				const { kind, label, toolCallId } = job.spec;
				write({
					session: id,
					id: job.id,
					kind,
					label,
					...(toolCallId !== undefined ? { toolCallId } : {}),
					work,
				});
				recorded.add(job.id);
				continue;
			}
			// Work of another kind is never a call's to record.
			if (work !== undefined) continue;
			const asks = (asked.get(job.id) ?? 0) + 1;
			asked.set(job.id, asks);
			if (asks < MOST_ASKS) waiting = true;
		}
		if (waiting) cancel = later(RECORD_AGAIN_MS, record);
	};

	return {
		changed() {
			cancel?.();
			record();
		},
		stop() {
			cancel?.();
			cancel = undefined;
		},
	};
}
