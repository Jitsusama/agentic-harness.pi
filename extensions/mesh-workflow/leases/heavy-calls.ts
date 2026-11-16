/**
 * Heavy work a tool call claims: the lease each call takes while it
 * runs, given back as it ends or hands off to the background, and
 * carried across a reload to the runtime it starts. A command handed
 * to the background claims heavy work whatever it runs, named by its
 * job and first words, so a mycelium node never moves a session out
 * from under it (5HJZ8Z, 16 November).
 */

import { sessionSlot } from "../../../lib/core/session/index.ts";
import {
	KIND_SAID,
	type Kind,
	kindOf,
	whatOf,
} from "../../../lib/internal/priority/queue.ts";
import { type LeaseEvent, MOST_HOLD_MS } from "../../../lib/mesh/lease.ts";

/**
 * How a bash call says it handed its command to the background, in
 * this code's words or older code's.
 */
const HANDED_OFF = /in the background as job (\S+)|as background command (\S+)/;

/** The longest a background command's subject runs, so it stays a line. */
const SUBJECT_MOST = 80;

/** How long a background command's claim lasts: as long as any lease. */
const BACKGROUND_MS = MOST_HOLD_MS;

/**
 * What a background command claims: its job and first words, so no two
 * commands share a claim and none is told another runs the same.
 */
function backgroundSubject(jobId: string, command: string): string {
	const subject = `background ${jobId.replace(/[.,;]$/, "")}: ${firstWords(command)}`;
	return subject.length > SUBJECT_MOST
		? `${subject.slice(0, SUBJECT_MOST - 3)}...`
		: subject;
}

/** A command's first line, trimmed. */
function firstWords(command: string): string {
	return (command.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

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
	/**
	 * A background command carried here through a restart or a move,
	 * labelled by its command's first line, runs on as `jobId`.
	 */
	takenUp(toolCallId: string, jobId: string, label: string): void;
	/** Forget every call, as a session ending does. */
	clear(): void;
	/** The calls still running, each with the heavy work it claimed. */
	held(): readonly HeavyCall[];
}

/** A call still running, and the heavy work it claimed. */
export type HeavyCall = readonly [toolCallId: string, subject: string];

/** A background command taken up before this peer held its leases. */
export type TakenCall = readonly [
	toolCallId: string,
	jobId: string,
	label: string,
];

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
	// Each command running, until it answers or hands off.
	const commands = new Map<string, string>();
	const background = (toolCallId: string, jobId: string, command: string) => {
		const subject = backgroundSubject(jobId, command);
		calls.set(toolCallId, subject);
		heavy({
			take: { subject, why: firstWords(command), ms: BACKGROUND_MS },
		});
	};
	// The heavy work a command runs by its kind, claimed, if it runs any.
	const ofKind = (toolCallId: string, command: string) => {
		const subject = kindOf(command);
		if (subject === undefined) return undefined;
		calls.set(toolCallId, subject);
		heavy({ take: { subject, why: why(command) } });
		return subject;
	};
	const ended = (toolCallId: string) => {
		const subject = calls.get(toolCallId);
		if (subject === undefined) return;
		calls.delete(toolCallId);
		if (![...calls.values()].includes(subject)) heavy({ release: subject });
	};
	return {
		called(toolCallId, command) {
			if (typeof command !== "string") return undefined;
			commands.set(toolCallId, command);
			return ofKind(toolCallId, command);
		},
		answered(toolCallId, content) {
			const command = commands.get(toolCallId);
			commands.delete(toolCallId);
			const jobId = handedOffAs(content);
			if (jobId === undefined) ended(toolCallId);
			else if (!calls.has(toolCallId) && command !== undefined) {
				background(toolCallId, jobId, command);
			}
		},
		finished: ended,
		takenUp(toolCallId, jobId, label) {
			if (ofKind(toolCallId, label) === undefined) {
				background(toolCallId, jobId, label);
			}
		},
		clear: () => {
			calls.clear();
			commands.clear();
		},
		held: () => [...calls],
	};
}

/** The job a call's answer says it handed its command to, if it did. */
function handedOffAs(content: readonly unknown[]): string | undefined {
	for (const part of content) {
		if (
			typeof part !== "object" ||
			part === null ||
			(part as { type?: unknown }).type !== "text"
		) {
			continue;
		}
		const handed = HANDED_OFF.exec(String((part as { text?: unknown }).text));
		if (handed) return handed[1] ?? handed[2];
	}
	return undefined;
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
