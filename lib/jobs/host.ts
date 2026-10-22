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
}

/** How a job ended, bounded, with the path or handle for the rest. */
export interface JobOutcome {
	readonly summary: string;
	readonly failed?: boolean;
}

/** One job the host is holding. */
export interface Job {
	readonly id: string;
	/** Fires when the person stops the job or its session ends. */
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
 * Why a job's signal fired. The person stopping a job means stop the
 * work; the session ending means the work has nobody to answer to,
 * which some work (a round whose answer is on disk) survives.
 */
export type JobStop = "person" | "session";

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
	return reason.jobStop === "person" || reason.jobStop === "session"
		? reason.jobStop
		: undefined;
}

/** The host a producer hands its background work to. */
export interface JobHost {
	start(spec: JobSpec): Job;
	/**
	 * How many jobs are running, or finished with results not yet said:
	 * what a reload would lose. Optional, so a host from before it reads
	 * as having none to say.
	 */
	pending?(): number;
}

/**
 * Asked by a producer that needs the host. The payload is a callback
 * the host answers into, which pi's bus runs before `emit` returns, so
 * the producer knows at once whether anybody is there.
 */
export const JOBS_ASK = "jobs:ask:v1";

/**
 * Said on the bus when a job's work ends, however it ends: finished,
 * stopped by the person, or stopped because its session ended. Its
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

/** Whether a payload is a callback to answer into. */
function isAnswer(data: unknown): data is (host: JobHost) => void {
	return typeof data === "function";
}

/** The host, if one is listening, found now. */
export function findJobHost(bus: EventBus): JobHost | undefined {
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
