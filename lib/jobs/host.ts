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
}

/** The host a producer hands its background work to. */
export interface JobHost {
	start(spec: JobSpec): Job;
}

/**
 * Asked by a producer that needs the host. The payload is a callback
 * the host answers into, which pi's bus runs before `emit` returns, so
 * the producer knows at once whether anybody is there.
 */
export const JOBS_ASK = "jobs:ask:v1";

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
