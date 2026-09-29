/**
 * A started round, held as a background job.
 *
 * `review_ask start` hands the session back at once, and nothing used
 * to say when the round was ready: the model polled, a turn at a time,
 * or forgot. With a job host loaded the round is held as a job, and
 * once no reviewer is left running the model is told to collect it.
 *
 * It tells rather than collects. A collect started here would race one
 * the model starts, and collecting files findings against a change,
 * which is not undoable. Saying so costs one turn and cannot double
 * anything.
 *
 * The round outlives its session by design, since everything it
 * produces is on disk. So only the person stopping the job stops the
 * round; a session ending stops the watching and nothing else.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { withCallSignal } from "@jitsusama/agentic-harness.core/exec";
import { findJobHost, type Job, jobStopOf } from "../../lib/jobs/index.ts";

/**
 * How often to look. A round runs for minutes, and each look reads a
 * lease per reviewer and may run ps, so a few seconds late is nothing
 * and a tighter loop is cost with no reader.
 */
const POLL_MS = 5000;

/** What watching a started round needs. */
export interface StartedRound {
	readonly bus: EventBus;
	readonly runId: string;
	/** One line for the job list, e.g. `council on shop/app#7`. */
	readonly label: string;
	/** Whether any reviewer in the round is still held by a live supervisor. */
	readonly isRunning: () => Promise<boolean>;
	/** Ask every reviewer in the round to stop. */
	readonly stop: () => Promise<void>;
	readonly pollMs?: number;
}

/** Hold a started round as a job, or undefined when no host is loaded. */
export function watchStartedRound(round: StartedRound): Job | undefined {
	const host = findJobHost(round.bus);
	if (host === undefined) return undefined;
	const job = host.start({ kind: "review", label: round.label });

	// Outside the start call's signal. The interval would otherwise carry
	// it, and every command a later look ran would be cancelled by a call
	// that returned long ago.
	withCallSignal(undefined, () => {
		let looking = false;
		const timer = setInterval(async () => {
			if (looking) return;
			looking = true;
			try {
				const running = await round.isRunning().catch(
					// A look that failed says nothing about the round, and
					// reading it as finished would send the model to collect
					// from under live reviewers, which collect refuses anyway.
					() => true,
				);
				if (running) return;
				clearInterval(timer);
				job.finish({
					summary: [
						`Review round ${round.runId} has no reviewer left running.`,
						`Run review_ask collect run=${round.runId} to file what they found.`,
					].join("\n"),
				});
			} finally {
				looking = false;
			}
		}, round.pollMs ?? POLL_MS);
		timer.unref?.();

		job.signal.addEventListener(
			"abort",
			() => {
				clearInterval(timer);
				if (jobStopOf(job.signal) !== "person") return;
				round.stop().catch(() => {
					// The person can still stop it with review_ask stop, and
					// a watcher has nobody to report a failure to.
				});
			},
			{ once: true },
		);
	});
	return job;
}
