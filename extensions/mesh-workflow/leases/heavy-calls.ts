/**
 * Heavy work a tool call claims: the lease each call takes while it
 * runs, given back as it ends or hands off to the background, and
 * carried across a reload to the runtime it starts.
 */

import { sessionSlot } from "../../../lib/core/session/index.ts";
import {
	KIND_SAID,
	type Kind,
	kindOf,
	whatOf,
} from "../../../lib/internal/priority/queue.ts";
import type { LeaseEvent } from "../../../lib/mesh/lease.ts";

/**
 * How a bash call says it handed its command to the background, in
 * this code's words or older code's.
 */
const HANDED_OFF = /in the background as job \S+|as background command \S+/;

/**
 * Heavy work as a sentence names it: the queue's words for its kind, or
 * the subject itself for one claimed some other way.
 */
export function heavySaid(subject: string): string {
	return KIND_SAID[subject as Kind] ?? `heavy work on ${subject}`;
}

/**
 * The heavy shell commands running, by call, so work two calls share is
 * given up only when the last of them ends. A call's work is over when
 * it answers, unless it handed its command to a job, which runs on past
 * the answer until the job says it has ended.
 */
export interface HeavyCalls {
	/** A bash call is starting: the heavy work it runs, if any. */
	called(toolCallId: string, command: unknown): string | undefined;
	/** A call answered, with these parts. */
	answered(toolCallId: string, content: readonly unknown[]): void;
	/** A job a call handed off has ended. */
	finished(toolCallId: string): void;
	/** Forget every call, as a session ending does. */
	clear(): void;
	/** The calls still running, each with the heavy work it claimed. */
	held(): readonly HeavyCall[];
}

/** A call still running, and the heavy work it claimed. */
export type HeavyCall = readonly [toolCallId: string, subject: string];

/**
 * Heavy calls whose work is running, from `carried` on: the calls a
 * reload handed over from the runtime before, whose work runs on.
 */
export function createHeavyCalls(
	heavy: (event: LeaseEvent) => void,
	why: (command: string) => string = whatOf,
	carried: readonly HeavyCall[] = [],
): HeavyCalls {
	const calls = new Map<string, string>(carried);
	const ended = (toolCallId: string) => {
		const subject = calls.get(toolCallId);
		if (subject === undefined) return;
		calls.delete(toolCallId);
		if (![...calls.values()].includes(subject)) heavy({ release: subject });
	};
	return {
		called(toolCallId, command) {
			const subject = typeof command === "string" ? kindOf(command) : undefined;
			if (subject === undefined || typeof command !== "string") {
				return undefined;
			}
			calls.set(toolCallId, subject);
			heavy({ take: { subject, why: why(command) } });
			return subject;
		},
		answered(toolCallId, content) {
			const handedOff = content.some(
				(part) =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: unknown }).type === "text" &&
					HANDED_OFF.test(String((part as { text?: unknown }).text)),
			);
			if (!handedOff) ended(toolCallId);
		},
		finished: ended,
		clear: () => calls.clear(),
		held: () => [...calls],
	};
}

/**
 * Where a reload leaves the heavy calls still running for the runtime it
 * starts. A reload evaluates this module again, so only a `Symbol.for`
 * key on `globalThis` outlives it; the version changes with the shape.
 */
const carriedCalls = () =>
	sessionSlot<HeavyCall[]>(
		"agentic-harness.mesh.heavy-calls.v1",
		undefined,
		() => [],
	);

/** Leave the heavy calls still running for the runtime a reload starts. */
export function parkHeavyCalls(calls: readonly HeavyCall[]): void {
	const carried = carriedCalls();
	carried.splice(0, carried.length, ...calls);
}

/** Take the heavy calls a reload left, once; none when it left none. */
export function takeHeavyCalls(): readonly HeavyCall[] {
	return carriedCalls().splice(0);
}

/** Whether a session is ending only to reload, as pi's shutdown event says. */
export function reloading(event: unknown): boolean {
	return (
		typeof event === "object" &&
		event !== null &&
		"reason" in event &&
		event.reason === "reload"
	);
}
