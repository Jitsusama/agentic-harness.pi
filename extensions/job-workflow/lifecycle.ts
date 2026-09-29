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
import { announceJobHost } from "../../lib/jobs/index.ts";
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

/** The footer line for these jobs, or nothing when there are none. */
function statusLine(jobs: Jobs): string | undefined {
	const all = jobs.list();
	if (all.length === 0) return undefined;
	const running = all.filter((job) => job.state === "running").length;
	const waiting = all.length - running;
	const parts = [
		running > 0 ? `${running} running` : "",
		waiting > 0 ? `${waiting} waiting` : "",
	];
	return `jobs: ${parts.filter(Boolean).join(", ")}`;
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
			ctx.ui.setStatus(STATUS_KEY, statusLine(jobs));
		} catch {
			// A stale context after a reload has no footer to update.
		}
	};
	const jobs = createJobs((result) => outbox.post(result), show);
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
