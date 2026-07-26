/**
 * Waiting, and admitting what happened.
 *
 * A wait that times out is not a failure to be swallowed. It is
 * the most informative moment in a session: the page did not
 * reach a state something expected it to reach. So an outcome
 * always says which condition it was, how long it waited, and
 * what it saw instead, rather than returning a bare false that
 * the caller has to guess at.
 */

import type { NetworkRequest } from "../telemetry/network.js";

/** What a caller can wait for. */
export type WaitCondition =
	| { readonly kind: "selector"; readonly selector: string }
	| { readonly kind: "gone"; readonly selector: string }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "idle"; readonly quietMs: number }
	| { readonly kind: "request"; readonly pattern: string }
	| { readonly kind: "animations" }
	| { readonly kind: "duration"; readonly ms: number };

/** How a wait ended. */
export interface WaitOutcome {
	readonly met: boolean;
	readonly waitedMs: number;
	readonly condition: WaitCondition;
	/** What was true instead, when the condition was not met. */
	readonly saw?: string;
	/** Anything the condition itself produced, such as a status. */
	readonly detail?: string;
}

/**
 * How long the network must be quiet to count as idle.
 *
 * Half a second is the interval a page's own deferred work
 * tends to fall inside: a font fetch kicked off by layout, or
 * an image requested once its container has a size. Calling
 * idle any sooner catches the gap between two requests rather
 * than the end of them.
 */
export const DEFAULT_QUIET_MS = 500;

/** Requests that have not finished one way or the other. */
export function inFlight(
	requests: readonly NetworkRequest[],
): readonly NetworkRequest[] {
	return requests.filter((request) => request.state === "pending");
}

/**
 * Whether the network has been quiet long enough.
 *
 * Quiet means two things at once: nothing is outstanding, and
 * nothing has finished recently either. A page that completes
 * one request and immediately starts another is busy, even
 * though there is an instant between them when nothing is in
 * flight.
 */
export function isIdle(
	requests: readonly NetworkRequest[],
	quietMs: number,
	/** The protocol's monotonic clock, in seconds, as requests carry it. */
	nowSeconds: number,
): boolean {
	if (inFlight(requests).length > 0) return false;
	const lastActivity = requests.reduce(
		(latest, request) => Math.max(latest, endOf(request)),
		Number.NEGATIVE_INFINITY,
	);
	// A session that has seen no requests at all is idle, not
	// infinitely busy.
	if (!Number.isFinite(lastActivity)) return true;
	return (nowSeconds - lastActivity) * MS_PER_SECOND >= quietMs;
}

/** Milliseconds in a second, since two clocks meet here. */
const MS_PER_SECOND = 1000;

/**
 * When a request stopped occupying the network, on the
 * protocol's monotonic clock in seconds.
 *
 * The two figures a request carries are in different units:
 * startedAt is the protocol's seconds and durationMs is our
 * rounded milliseconds, so one has to be converted rather than
 * added straight on.
 */
function endOf(request: NetworkRequest): number {
	return request.startedAt + (request.durationMs ?? 0) / MS_PER_SECOND;
}

/** Say what happened, in a sentence a caller can act on. */
export function renderWait(outcome: WaitOutcome): string {
	const took = `${Math.round(outcome.waitedMs)}ms`;
	const what = describe(outcome.condition);

	if (outcome.met) {
		return outcome.detail
			? `Waited ${took} for ${what}. ${outcome.detail}`
			: `Waited ${took} for ${what}.`;
	}

	// The thing that did not happen is the headline, and what was
	// true instead is the reason it is worth reading.
	const instead = outcome.saw ? ` ${outcome.saw}` : "";
	return `Gave up after ${took}. Still waiting for ${what}.${instead}`;
}

/** Name a condition the way it would be asked for. */
function describe(condition: WaitCondition): string {
	switch (condition.kind) {
		case "selector":
			return `'${condition.selector}' to appear`;
		case "gone":
			return `'${condition.selector}' to go away`;
		case "text":
			return `the text '${condition.text}' to appear`;
		case "idle":
			return `the network to go quiet for ${condition.quietMs}ms`;
		case "request":
			return `a request matching '${condition.pattern}' to finish`;
		case "animations":
			return "animations to settle";
		case "duration":
			return `${condition.ms}ms to pass`;
	}
}
