/**
 * The seam between work that runs in the background and the host
 * that says its result.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** What a job is, for the person listing jobs and the model reading its result. */
export interface JobSpec {
	/** The tool or domain that started it, e.g. `subagent`. */
	readonly kind: string;
	/** One line saying what it is doing. */
	readonly label: string;
	/**
	 * The tool call whose work this job carries on with, when a call
	 * handed itself off, so whoever tied something to that call (a
	 * lease, a row) can tell when the work behind it ends.
	 */
	readonly toolCallId?: string;
	/**
	 * How the job goes on in another process when its session moves there,
	 * for work that lives outside this one. A job without it holds a move
	 * until it ends.
	 */
	readonly carry?: JobCarry;
}

/**
 * What another process needs to take a job's work up, as plain data the
 * session's log can hold: its `kind` says who reads the rest.
 */
export interface CarriedWork {
	readonly kind: string;
	readonly [field: string]: unknown;
}

/** How a job's work is handed to another process. */
export interface JobCarry {
	/**
	 * What the other process takes the work up from, or nothing when it
	 * can't be carried now. Asking changes nothing.
	 */
	what(): CarriedWork | undefined;
	/** It has been handed over: let it run on, and say nothing of it here. */
	handed(): void;
}

/** A running job that holds its session's move, named. */
export interface JobHold {
	readonly id: string;
	readonly kind: string;
	readonly label: string;
}

/** How a job ended, bounded, with the path or handle for the rest. */
export interface JobOutcome {
	readonly summary: string;
	readonly failed?: boolean;
}

/** One job the host is holding. */
export interface Job {
	readonly id: string;
	/** Fires when the person or the agent stops the job, or its session ends. */
	readonly signal: AbortSignal;
	/** Say the result. Called once; a second call is ignored. */
	finish(outcome: JobOutcome): void;
	/** Called once the result is in the session, so progress can go. */
	onDelivered(listener: () => void): void;
	/**
	 * Take back a finished result that has not gone out yet, because what
	 * it says stopped being true while it waited. True when it was taken
	 * back; false when it has already been sent, or was never finished.
	 */
	withdraw(): boolean;
}

/**
 * Why a job's signal fired. The person or the agent stopping a job
 * means stop the work; the session ending means the work has nobody to
 * answer to, which some work (a round whose answer is on disk) survives.
 */
export type JobStop = "person" | "agent" | "session";

const STOPS: ReadonlySet<unknown> = new Set<JobStop>([
	"person",
	"agent",
	"session",
]);

/** What a host aborts a job's signal with, so the producer can tell why. */
export function jobStopReason(stop: JobStop): { readonly jobStop: JobStop } {
	return { jobStop: stop };
}

/** Why this job's signal fired, if it has and a host said. */
export function jobStopOf(signal: AbortSignal): JobStop | undefined {
	if (!signal.aborted) return undefined;
	const reason: unknown = signal.reason;
	if (typeof reason !== "object" || reason === null) return undefined;
	if (!("jobStop" in reason)) return undefined;
	return STOPS.has(reason.jobStop) ? (reason.jobStop as JobStop) : undefined;
}

/** The host a producer hands its background work to. */
export interface JobHost {
	start(spec: JobSpec): Job;
	/**
	 * How many jobs are running, or finished with results not yet said:
	 * what switching sessions would lose (a reload loses none of them).
	 * Optional, so a host from before it reads as having none to say.
	 */
	pending?(): number;
	/**
	 * The running jobs that hold a move, since they can't be carried, or
	 * whose work `carriable` refuses, as a host restart refuses all but
	 * the shell's. Optional, so a host from before it holds a move on all
	 * `pending`.
	 */
	holds?(carriable?: (work: CarriedWork) => boolean): readonly JobHold[];
}

/**
 * Asked by a producer that needs the host. The payload is a callback
 * the host answers into, which pi's bus runs before `emit` returns, so
 * the producer knows at once whether anybody is there.
 */
export const JOBS_ASK = "jobs:ask:v1";

/**
 * Asked by a runtime starting for a session: a runtime still holding
 * that session's jobs parks them for it. pi's reload is not one at a
 * time, and two that overlap leave a replaced runtime live, its host
 * first on the bus. The payload names the session and is marked
 * `parked` by whoever parks, before `emit` returns.
 */
export const JOBS_YIELD = "jobs:yield:v1";

/**
 * Said on the bus when a job's work ends, however it ends: finished,
 * stopped by the person or the agent, or stopped because its session
 * ended. Its
 * answer may still be waiting to be said; this is about the work.
 */
export const JOBS_FINISHED = "jobs:finished:v1";

/** What `JOBS_FINISHED` carries. */
export interface JobFinished {
	readonly jobId: string;
	readonly kind: string;
	/** The call it carried on for, when it was handed off by one. */
	readonly toolCallId?: string;
	readonly failed: boolean;
}

/** Whether a payload is a job's end, as this version says one. */
function isFinished(data: unknown): data is JobFinished {
	if (typeof data !== "object" || data === null) return false;
	const { jobId, kind, toolCallId, failed } = data as Record<string, unknown>;
	return (
		typeof jobId === "string" &&
		typeof kind === "string" &&
		(toolCallId === undefined || typeof toolCallId === "string") &&
		typeof failed === "boolean"
	);
}

/** Hear every job's end. Returns a disposer. */
export function onJobFinished(
	bus: EventBus,
	listener: (finished: JobFinished) => void,
): () => void {
	return bus.on(JOBS_FINISHED, (data) => {
		if (isFinished(data)) listener(data);
	});
}

/**
 * Said on the bus as a session hands its jobs to another process, once
 * their record is written: the jobs, as the process taking them up
 * reads them. A host keeps what it carried out of its own cgroup by it.
 */
export const JOBS_CARRIED = "jobs:carried:v1";

/** A job handed to another process, as `JOBS_CARRIED` names it. */
export interface JobCarried {
	readonly id: string;
	readonly kind: string;
	readonly label: string;
	readonly toolCallId?: string;
	readonly work: CarriedWork;
}

/** What `JOBS_CARRIED` carries. */
export interface JobsCarried {
	/** The session the jobs were carried from, by key. */
	readonly session: string;
	readonly jobs: readonly JobCarried[];
}

/**
 * Said on the bus as a session takes up a job another process carried
 * to it, before the job's work is looked at, so whoever tied something
 * to the call (a lease) can tie it again and hear the job's end.
 */
export const JOBS_TAKEN_UP = "jobs:taken-up:v1";

/** What `JOBS_TAKEN_UP` carries. */
export interface JobTakenUp {
	readonly jobId: string;
	readonly kind: string;
	readonly label: string;
	readonly toolCallId?: string;
}

function isWork(value: unknown): value is CarriedWork {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>).kind === "string"
	);
}

function isTakenUp(data: unknown): data is JobTakenUp {
	if (typeof data !== "object" || data === null) return false;
	const { jobId, kind, label, toolCallId } = data as Record<string, unknown>;
	return (
		typeof jobId === "string" &&
		typeof kind === "string" &&
		typeof label === "string" &&
		(toolCallId === undefined || typeof toolCallId === "string")
	);
}

/** Whether a payload is a session's carried jobs, as this version says them. */
export function isJobsCarried(data: unknown): data is JobsCarried {
	if (typeof data !== "object" || data === null) return false;
	const { session, jobs } = data as Record<string, unknown>;
	return (
		typeof session === "string" && Array.isArray(jobs) && jobs.every(isCarried)
	);
}

function isCarried(job: unknown): job is JobCarried {
	if (typeof job !== "object" || job === null) return false;
	const { id, kind, label, toolCallId, work } = job as Record<string, unknown>;
	return (
		typeof id === "string" &&
		typeof kind === "string" &&
		typeof label === "string" &&
		(toolCallId === undefined || typeof toolCallId === "string") &&
		isWork(work)
	);
}

/** Hear every job a session takes up from another process. Returns a disposer. */
export function onJobTakenUp(
	bus: EventBus,
	listener: (taken: JobTakenUp) => void,
): () => void {
	return bus.on(JOBS_TAKEN_UP, (data) => {
		if (isTakenUp(data)) listener(data);
	});
}

/** Whether a payload is a callback to answer into. */
function isAnswer(data: unknown): data is (host: JobHost) => void {
	return typeof data === "function";
}

/**
 * The host, if one is listening, found now. It only asks, so any bus
 * that can emit will do, a pi host's own included.
 */
export function findJobHost(bus: Pick<EventBus, "emit">): JobHost | undefined {
	let found: JobHost | undefined;
	bus.emit(JOBS_ASK, (host: JobHost) => {
		found ??= host;
	});
	return found;
}

/** Answer every producer asking for a host. Returns a disposer. */
export function announceJobHost(bus: EventBus, host: JobHost): () => void {
	return bus.on(JOBS_ASK, (data) => {
		if (isAnswer(data)) data(host);
	});
}
