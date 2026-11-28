/**
 * When a queued job is due to start: as its command tells the queue, or
 * by a bound for its kind. A keep that finds a job still waiting past
 * it tells the job's waiter where it stands (late.ts): a run promised to
 * start could sit in the line unstarted with nobody waiting on it told
 * why, and a review cell counted 14 such changes in one week.
 */

import { homedir } from "node:os";
import { QUICK_OUTRUN_MS, VM_SETTLE_MS } from "./bounds.ts";
import { isQuick, type Job } from "./job.ts";
import type { Kind } from "./needs.ts";
import { JOINS_FOR_MS, PASS_AFTER_MS } from "./next-turn.ts";
import { kindOf } from "./queue.ts";
import { variableAtStep } from "./step-variable.ts";
import type { Where } from "./world-walk.ts";

/**
 * The variable a command sets to say when its work is due to start by,
 * as it sets `WORLD_PUSH_CLASS`: epoch seconds, or `+N` for N minutes
 * from when it asks.
 */
export const DUE_TO_START_VARIABLE = "PI_DUE_TO_START";

/** A due time in epoch seconds, as `date +%s` gives it. */
const EPOCH_SECONDS = /^\d+$/;

/** A due time as a number of minutes from when the job asks, as `+15`. */
const MINUTES_FROM_NOW = /^\+(\d+)$/;

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

/**
 * How long past asking each kind is due to start by, when its command
 * says nothing: the longest the queue's own rules mean that kind to wait
 * when nothing is wrong, so a job waiting past it is held by more than
 * the line's ordinary turns.
 *
 * - Builds, benchmarks, deploy stamps and timed runs: next-turn.ts's
 *   {@link PASS_AFTER_MS}, past which the rules themselves count a job
 *   memory holds as stuck and let the work that fits pass it.
 * - VM tests and checks: bounds.ts's {@link VM_SETTLE_MS}, the longest
 *   one VM's settling holds the next back.
 * - Walks of World's objects: next-turn.ts's {@link JOINS_FOR_MS}, the
 *   longest a running fetch of main holds the walks waiting on it.
 *
 * Quick work is due within {@link QUICK_OUTRUN_MS} whatever its kind: it
 * passes the line one job at a time, so it waits no longer than a quick
 * job before it is let run.
 */
export const DUE_WITHIN_MS: Readonly<Record<Kind, number>> = {
	"vm-test": VM_SETTLE_MS,
	"vm-check": VM_SETTLE_MS,
	benchmark: PASS_AFTER_MS,
	build: PASS_AFTER_MS,
	"world-walk": JOINS_FOR_MS,
	stamp: PASS_AFTER_MS,
	"timed-run": PASS_AFTER_MS,
};

/** When a job is due by its kind's bound alone, past when it asked. */
function dueByKind(job: Job): number {
	const within = isQuick(job) ? QUICK_OUTRUN_MS : DUE_WITHIN_MS[job.kind];
	return Date.parse(job.since) + within;
}

/**
 * When job `asked`, run as `command`, is due to start, in epoch ms:
 * {@link DUE_TO_START_VARIABLE} as the command's heavy step sees it
 * (step-variable.ts's `variableAtStep`), set for that step, exported
 * before it, or `inherited` from the shell; else, or for a value read as
 * neither form, its kind's bound past when it asked
 * ({@link DUE_WITHIN_MS}).
 */
export function dueToStartOf(
	command: string,
	asked: Job,
	where: Where = { home: homedir() },
	inherited?: string,
): number {
	const given = variableAtStep(
		command,
		DUE_TO_START_VARIABLE,
		(steps) => kindOf(steps.join("\n"), where) !== undefined,
		inherited,
	);
	return (
		(given === undefined ? undefined : dueOf(given, Date.parse(asked.since))) ??
		dueByKind(asked)
	);
}

/** A value of {@link DUE_TO_START_VARIABLE} as epoch ms, read at `now`. */
function dueOf(value: string, now: number): number | undefined {
	if (EPOCH_SECONDS.test(value)) return Number(value) * SECOND_MS;
	const minutes = MINUTES_FROM_NOW.exec(value)?.[1];
	return minutes === undefined ? undefined : now + Number(minutes) * MINUTE_MS;
}

/**
 * When a queued job is due to start by: its own {@link Job.dueToStart},
 * or, for a job file an older harness wrote without one, its kind's
 * bound past when it asked, so a mixed install tells its waiters too.
 */
export function dueBy(job: Job): number {
	return typeof job.dueToStart === "number" && Number.isFinite(job.dueToStart)
		? job.dueToStart
		: dueByKind(job);
}
