/**
 * Each running bash job of a session, recorded beside what its call
 * keeps on disk (lib/internal/shell/kept-jobs.ts), so the session takes
 * it up again when its pi or its host is killed outright, which carries
 * nothing through the log.
 *
 * A job's work is asked for each time the registry changes. A call
 * handed off the moment it started may not have written its shell's pid
 * yet, and has nothing to record until it has, so one not yet
 * recordable is asked again a second on, for a minute at most. A record
 * names its session, so one rolled over to another is recorded again
 * under the new one, and its pi, so no other pi takes up a call this one
 * still holds. A session's close for good stops its calls, so it takes
 * their records back first (`forget`): no reaper spares what it stops.
 *
 * Started again, the session takes up each recorded call still running,
 * or ended with its status, that nothing else has taken up
 * (`recordedCarry`), as a move's would be (moved.ts).
 *
 * Every running job, of any kind, is also noted by session (running.ts),
 * so a session killed while it waited on jobs nothing can take up, a
 * fleet or a review round, is told they ended with it.
 */

import { isCarriedShell } from "../../lib/internal/shell/carried.ts";
import {
	forgetKeptJob,
	type KeptJob,
	keptJobsOf,
	recordKeptJob,
} from "../../lib/internal/shell/kept-jobs.ts";
import type { Jobs } from "./jobs.ts";
import type { Carried } from "./moved.ts";
import {
	forgetRunning,
	noteRunning,
	type RunningNote,
} from "./running.ts";

/** How long to wait before asking a job not yet recordable again. */
const RECORD_AGAIN_MS = 1000;

/** How long a job not yet recordable is asked for, from its first ask. */
export const RECORD_FOR_MS = 60_000;

/** What records a session's jobs. */
export interface JobRecorder {
	/** The registry changed: record what is running and not yet recorded. */
	changed(): void;
	/** Stop asking again; a later change records again. */
	stop(): void;
	/** Stop for good, taking back every record this recorder wrote. */
	forget(): void;
}

/** How a recorder writes and waits, for tests to stand in for. */
interface RecorderOptions {
	readonly write?: (job: KeptJob) => void;
	readonly forget?: (keep: string) => void;
	readonly later?: (ms: number, run: () => void) => () => void;
	readonly now?: () => number;
	/** The pi holding the jobs, by its pid; this process by default. */
	readonly owner?: number;
	/** Note a session's running jobs, of every kind (running.ts). */
	readonly note?: (session: string, note: RunningNote) => void;
	/** Take a session's note back. */
	readonly unnote?: (session: string) => void;
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
 * Record the running bash jobs of `jobs()` for `session`, each once, and
 * note every running job of any kind. A session with no id can't be
 * found again, so nothing is recorded.
 */
export function recordJobs(
	jobs: () => Pick<Jobs, "list"> | undefined,
	session: () => string | undefined,
	options: RecorderOptions = {},
): JobRecorder {
	const write = options.write ?? recordKeptJob;
	const forget = options.forget ?? forgetKeptJob;
	const later = options.later ?? laterOnce;
	const now = options.now ?? Date.now;
	const owner = options.owner ?? process.pid;
	const note = options.note ?? noteRunning;
	const unnote = options.unnote ?? forgetRunning;
	// Each job's kept path, by its session and id, once recorded there.
	const recorded = new Map<string, string>();
	const firstAsked = new Map<string, number>();
	let cancel: (() => void) | undefined;
	let forgotten = false;
	// The note this recorder wrote last, by session, and what it said.
	let noted: { session: string; said: string } | undefined;

	// Only a note this recorder wrote is taken back: a session that comes
	// back reads the one its last pi left before its jobs change.
	const noteNow = (id: string, running: RunningNote["jobs"]) => {
		if (noted !== undefined && noted.session !== id) {
			unnote(noted.session);
			noted = undefined;
		}
		if (running.length === 0) {
			if (noted !== undefined) unnote(id);
			noted = undefined;
			return;
		}
		const said = JSON.stringify(running);
		if (noted?.said === said) return;
		note(id, { owner, jobs: running });
		noted = { session: id, said };
	};

	const record = () => {
		cancel = undefined;
		const id = session();
		const held = jobs();
		if (forgotten || id === undefined || held === undefined) return;
		noteNow(
			id,
			held
				.list()
				.filter((job) => job.state === "running")
				.map((job) => ({ id: job.id, label: job.spec.label })),
		);
		let waiting = false;
		for (const job of held.list()) {
			if (job.state !== "running" || !job.spec.carry) continue;
			const key = `${id}\n${job.id}`;
			if (recorded.has(key)) continue;
			const work = job.spec.carry.what();
			if (isCarriedShell(work)) {
				const { kind, label, toolCallId } = job.spec;
				write({
					session: id,
					id: job.id,
					kind,
					label,
					...(toolCallId !== undefined ? { toolCallId } : {}),
					owner,
					work,
				});
				recorded.set(key, work.keep);
				continue;
			}
			// Work of another kind is never a call's to record.
			if (work !== undefined) continue;
			const first = firstAsked.get(job.id) ?? now();
			firstAsked.set(job.id, first);
			if (now() - first < RECORD_FOR_MS) waiting = true;
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
		forget() {
			forgotten = true;
			cancel?.();
			cancel = undefined;
			for (const keep of new Set(recorded.values())) forget(keep);
			recorded.clear();
			if (noted !== undefined) unnote(noted.session);
			noted = undefined;
		},
	};
}
