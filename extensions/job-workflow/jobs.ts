/**
 * The jobs a session is holding: running, finished and waiting to be
 * said, or said and gone.
 *
 * A job is held from `start` until its result is in the session, so its
 * producer can keep showing progress until then and the person can see
 * it in the list. The registry owns each job's stop, so stopping the
 * session stops everything it started.
 */

import {
	type Job,
	type JobHost,
	type JobOutcome,
	type JobSpec,
	jobStopReason,
} from "../../lib/jobs/index.ts";
import type { JobResult } from "./outbox.ts";

/**
 * The most of a summary said to the model. A producer puts the whole
 * output somewhere and names it in the summary; this bounds one that
 * did not.
 */
export const MAX_SUMMARY_CHARS = 4_000;

/** One job as the list shows it. */
export interface JobEntry {
	readonly id: string;
	readonly spec: JobSpec;
	readonly state: "running" | "finished";
}

/** The registry, which is also the host producers are handed. */
export interface Jobs extends JobHost {
	list(): readonly JobEntry[];
	/** Stop a job for the person, saying so to the model. */
	stop(id: string): void;
	/** These results are in the session: tell their producers and let go. */
	delivered(isWaiting: (id: string) => boolean): void;
	/** The session ended: stop everything and accept nothing more. */
	close(): void;
}

interface Held {
	readonly spec: JobSpec;
	readonly controller: AbortController;
	readonly listeners: (() => void)[];
	finished: boolean;
}

/** What a finished job says, bounded. */
function bounded(outcome: JobOutcome): string {
	const text = outcome.failed ? `Failed. ${outcome.summary}` : outcome.summary;
	if (text.length <= MAX_SUMMARY_CHARS) return text;
	return `${text.slice(0, MAX_SUMMARY_CHARS)}\n[cut at ${MAX_SUMMARY_CHARS} characters]`;
}

/** A registry whose finished jobs go to `post`, telling `changed` each time. */
export function createJobs(
	post: (result: JobResult) => void,
	changed: () => void,
): Jobs {
	const held = new Map<string, Held>();
	let next = 1;
	let closed = false;

	const finish = (id: string, outcome: JobOutcome) => {
		const job = held.get(id);
		if (!job || job.finished || closed) return;
		job.finished = true;
		post({ jobId: id, label: job.spec.label, text: bounded(outcome) });
		changed();
	};

	return {
		start(spec): Job {
			const id = `j${next++}`;
			const controller = new AbortController();
			const job: Held = { spec, controller, listeners: [], finished: false };
			if (closed) controller.abort(jobStopReason("session"));
			else held.set(id, job);
			changed();
			return {
				id,
				signal: controller.signal,
				finish: (outcome) => finish(id, outcome),
				onDelivered: (listener) => {
					job.listeners.push(listener);
				},
			};
		},
		list: () =>
			[...held].map(([id, job]) => ({
				id,
				spec: job.spec,
				state: job.finished ? "finished" : "running",
			})),
		stop(id) {
			const job = held.get(id);
			if (!job || job.finished) return;
			finish(id, { summary: "Stopped by the person before it finished." });
			job.controller.abort(jobStopReason("person"));
		},
		delivered(isWaiting) {
			for (const [id, job] of held) {
				if (!job.finished || isWaiting(id)) continue;
				held.delete(id);
				for (const listener of job.listeners.splice(0)) listener();
			}
			changed();
		},
		close() {
			closed = true;
			for (const job of held.values()) {
				job.controller.abort(jobStopReason("session"));
			}
			held.clear();
		},
	};
}
