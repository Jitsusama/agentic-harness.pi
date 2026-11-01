/**
 * One session's jobs, from `session_start` until the session ends.
 *
 * A new session, a resume, a fork and a quit stop every job the session
 * started and drop whatever was waiting to be said, because a result
 * belongs to the conversation it was started in.
 *
 * A reload is not the session ending. pi stops nothing on a reload: the
 * process, the bus and every child it runs go on, and only the old `pi`
 * and `ctx` go stale. So the jobs are parked instead (carry.ts), still
 * running, and the runtime the reload starts takes them over, saying
 * their results through its own `pi`. Jobs nobody takes over are
 * stopped as before once the wait for one runs out.
 *
 * Nor is a rollover: it switches into a fresh log that carries the same
 * conversation on, naming this log as its parent, so the jobs are parked
 * for the fresh session the same way. Rollovers used to wait for no job
 * to be running, and a session that always waited on one in the
 * background never rolled over: on 2026-11-01 a 70 MB log went nine
 * hours and three compactions past the threshold.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createReloadHold } from "../../lib/internal/reload/hold.ts";
import {
	announceJobHost,
	JOBS_FINISHED,
	JOBS_YIELD,
	type JobFinished,
} from "../../lib/jobs/index.ts";
import { footerMark, type MarkTheme } from "../../lib/ui/footer-mark.ts";
import {
	CARRY_MS,
	park as parkJobs,
	sessionIdOf,
	takeParked,
} from "./carry.ts";
import { createJobs, type Jobs } from "./jobs.ts";
import { createOutbox, type Outbox } from "./outbox.ts";

/**
 * What a starting runtime asks on `JOBS_YIELD` with, and hears back on.
 * On 24 October a runtime two overlapping reloads left live held the
 * carried jobs while the new runtime's list said there were none, and
 * said a result nobody marked as seen every 30 seconds.
 */
interface YieldAsk {
	readonly session: string;
	parked: boolean;
}

function isYieldAsk(data: unknown): data is YieldAsk {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { session?: unknown }).session === "string"
	);
}

/** Have whatever runtime still hosts `session`'s jobs park them; whether one did. */
function askToYield(pi: ExtensionAPI, session: string | undefined): boolean {
	if (session === undefined) return false;
	const ask: YieldAsk = { session, parked: false };
	try {
		pi.events.emit(JOBS_YIELD, ask);
	} catch {
		// A runtime that can't ask has nobody to take over from.
		return false;
	}
	return ask.parked;
}

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
	/** The session ended: stop every job and drop what waits. */
	close(): void;
	/**
	 * The runtime is reloading, or the session rolling over: keep every
	 * job running, for the runtime that starts next to take over, and stop
	 * them only if none does within `carryMs`. They are parked for
	 * `forSession`, the session carrying this one on, or this one itself.
	 */
	park(carryMs?: number, forSession?: string): void;
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

/** The runtime a session's jobs speak through, replaced on a reload. */
interface Runtime {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
}

/**
 * Why a session starts when a runtime may have parked jobs for it: a
 * reload, or a rollover, which pi starts as a resume. A resume of
 * another conversation finds nothing parked under its id.
 */
const TAKES_PARKED = new Set(["reload", "resume"]);

/**
 * The session's jobs: those a reload or a rollover parked for this
 * session when there are any, and otherwise a fresh set, announced as
 * the host.
 */
export function openSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason?: string,
): JobSession {
	const id = sessionIdOf(ctx);
	const yielded = askToYield(pi, id);
	const carried =
		(reason !== undefined && TAKES_PARKED.has(reason)) || yielded
			? takeParked(id, pi, ctx)
			: undefined;
	return carried ?? freshSession(pi, ctx);
}

/** A session with no jobs yet, announced as the host. */
function freshSession(pi: ExtensionAPI, ctx: ExtensionContext): JobSession {
	let runtime: Runtime = { pi, ctx };
	// Ends heard while parked, said once a runtime takes the jobs over:
	// the parked `pi` cannot say anything, and the mesh releases a lease
	// on hearing one.
	let unsaid: JobFinished[] | undefined;

	// A result waits a moment for a reload that is waiting, which this
	// session carries across and says from the new runtime (hold.ts).
	const holdForReload = createReloadHold();
	const outbox = createOutbox({
		send: (text) => runtime.pi.sendUserMessage(text),
		idle: () => {
			try {
				return runtime.ctx.isIdle() && !holdForReload();
			} catch {
				// A stale context after a reload: not a moment to send.
				return false;
			}
		},
		now: Date.now,
	});
	const show = () => {
		try {
			runtime.ctx.ui.setStatus(
				STATUS_KEY,
				statusLine(jobs, runtime.ctx.ui.theme),
			);
		} catch {
			// A stale context after a reload has no footer to update.
		}
	};
	const say = (finished: JobFinished) => {
		if (unsaid) {
			unsaid.push(finished);
			return;
		}
		try {
			runtime.pi.events.emit(JOBS_FINISHED, finished);
		} catch {
			// A stale `pi` whose runtime was replaced some way other than a
			// reload; nobody is left listening on its bus.
		}
	};
	const jobs = createJobs(
		(result) => outbox.post(result),
		show,
		(jobId) => outbox.withdraw(jobId),
		say,
	);

	let withdraw: (() => void) | undefined;
	let yielding: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const listen = () => {
		withdraw = announceJobHost(runtime.pi.events, jobs);
		yielding = runtime.pi.events.on(JOBS_YIELD, (data) => {
			if (!isYieldAsk(data) || data.parked) return;
			if (data.session !== sessionIdOf(runtime.ctx)) return;
			data.parked = true;
			session.park();
		});
		timer = setInterval(() => outbox.tick(), TICK_MS);
		timer.unref();
	};
	const quiet = () => {
		withdraw?.();
		withdraw = undefined;
		yielding?.();
		yielding = undefined;
		clearInterval(timer);
		timer = undefined;
	};

	const session: JobSession = {
		jobs,
		outbox,
		seen(text) {
			outbox.seen(text);
			const waiting = new Set(outbox.waiting().map((result) => result.jobId));
			jobs.delivered((id) => waiting.has(id));
		},
		close() {
			quiet();
			jobs.close();
			show();
		},
		park(carryMs = CARRY_MS, forSession) {
			quiet();
			unsaid = [];
			parkJobs(
				{
					session: forSession ?? sessionIdOf(runtime.ctx),
					adopt(next, nextCtx) {
						runtime = { pi: next, ctx: nextCtx };
						const ends = unsaid ?? [];
						unsaid = undefined;
						listen();
						for (const finished of ends) say(finished);
						show();
						outbox.tick();
						return session;
					},
					stop: () => jobs.close(),
				},
				carryMs,
			);
		},
	};
	listen();
	return session;
}
