/**
 * One session's jobs, from `session_start` until `session_shutdown`.
 *
 * Nothing outlives the session: a reload, a new session and a quit all
 * stop every job it started and drop whatever was waiting to be said,
 * because the `pi` a result would be said through is stale by then.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { announceJobHost, JOBS_FINISHED } from "../../lib/jobs/index.ts";
import { footerMark, type MarkTheme } from "../../lib/ui/footer-mark.ts";
import { createJobs, type Jobs } from "./jobs.ts";
import { createOutbox, type Outbox } from "./outbox.ts";

/** How often the outbox looks again, for a prompt that went nowhere. */
const TICK_MS = 1_000;

/** The footer slot the job count sits in. */
const STATUS_KEY = "jobs";

/** A session's jobs and the outbox their results wait in. */
export interface JobSession {
	readonly jobs: Jobs;
	readonly outbox: Outbox;
	/** A user message reached the session. */
	seen(text: string): void;
	close(): void;
}

/**
 * The footer mark for these jobs: the hourglass while any is running,
 * with a count once there is more than one, and nothing otherwise.
 *
 * A finished job whose result is waiting to be said is left out. It is
 * said as soon as the session is idle, so the person would do nothing
 * for seeing it, and `/jobs` lists it for whoever wonders.
 */
export function statusLine(
	jobs: Pick<Jobs, "list">,
	theme: MarkTheme,
): string | undefined {
	const running = jobs.list().filter((job) => job.state === "running").length;
	if (running === 0) return undefined;
	return footerMark("background", "muted", theme, running);
}

/** Open a session's jobs and announce them as the host. */
export function openSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): JobSession {
	const outbox = createOutbox({
		send: (text) => pi.sendUserMessage(text),
		idle: () => {
			try {
				return ctx.isIdle();
			} catch {
				// A stale context after a reload: not a moment to send.
				return false;
			}
		},
		now: Date.now,
	});
	const show = () => {
		try {
			ctx.ui.setStatus(STATUS_KEY, statusLine(jobs, ctx.ui.theme));
		} catch {
			// A stale context after a reload has no footer to update.
		}
	};
	const jobs = createJobs(
		(result) => outbox.post(result),
		show,
		(jobId) => outbox.withdraw(jobId),
		(finished) => pi.events.emit(JOBS_FINISHED, finished),
	);
	const withdraw = announceJobHost(pi.events, jobs);
	const timer = setInterval(() => outbox.tick(), TICK_MS);
	timer.unref();

	return {
		jobs,
		outbox,
		seen(text) {
			outbox.seen(text);
			const waiting = new Set(outbox.waiting().map((result) => result.jobId));
			jobs.delivered((id) => waiting.has(id));
		},
		close() {
			withdraw();
			clearInterval(timer);
			jobs.close();
			show();
		},
	};
}
