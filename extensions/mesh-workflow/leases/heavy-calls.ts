/**
 * Heavy work a tool call claims: the lease each call takes while it
 * runs, given back as it ends or hands off to the background, and
 * carried across a reload to the runtime it starts. A command handed
 * to the background claims heavy work, named by its job and first
 * words, so a mycelium node never moves a session out from under it
 * (5HJZ8Z, 16 November), unless it only waits and reads
 * (lib/internal/priority/only-waits.ts): on 23 November seven ordered
 * carries were refused, each on the session's own poll loop. A command
 * known only by a label cut short ("...") still claims, since what was
 * cut can't be read. The jobs judged waits by their whole command are
 * kept by call, so a carry names them as stopped though their labels
 * are cut.
 */

import { sessionSlot } from "../../../lib/core/session/index.ts";
import {
	onlyWaits,
	wholeWait,
} from "../../../lib/internal/priority/only-waits.ts";
import {
	KIND_SAID,
	type Kind,
	kindOf,
	whatOf,
} from "../../../lib/internal/priority/queue.ts";
import {
	type LeaseEvent,
	leaseSubject,
	MOST_HOLD_MS,
} from "../../../lib/mesh/lease.ts";

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
	const subject = `background ${bareJob(jobId)}: ${firstWords(command)}`;
	return subject.length > SUBJECT_MOST
		? `${subject.slice(0, SUBJECT_MOST - 3)}...`
		: subject;
}

/** A job's id as the job host names it, without the sentence's stop. */
function bareJob(jobId: string): string {
	return jobId.replace(/[.,;]$/, "");
}

/** A command's first line, trimmed. */
function firstWords(command: string): string {
	return (command.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

/**
 * Heavy work as a sentence names it: the queue's words for its kind, or
 * the subject itself for one claimed some other way, cut as a lease's
 * words are, since its holder wrote it as it liked.
 */
export function heavySaid(subject: string): string {
	return isKind(subject)
		? KIND_SAID[subject]
		: `heavy work on ${leaseSubject(subject)}`;
}

/**
 * Whether a subject is a kind the queue names, as its own key: one
 * named for what every object inherits, as `constructor`, is not.
 */
function isKind(subject: string): subject is Kind {
	return Object.hasOwn(KIND_SAID, subject);
}

/**
 * The heavy shell commands running, by call, so work two calls share is
 * given up only when the last of them ends. A call's work is over when
 * it answers, unless it handed its command to a job, which runs on past
 * the answer until the job says it has ended. A call a later handler
 * refused never answers: pi ends it without its `tool_result`, so its
 * end alone gives its work up.
 */
export interface HeavyCalls {
	/** A bash call is starting: the heavy work it runs, if any. */
	called(toolCallId: string, command: unknown): string | undefined;
	/** A call answered, with these parts. */
	answered(toolCallId: string, content: readonly unknown[]): void;
	/** A job a call handed off has ended. */
	finished(toolCallId: string): void;
	/**
	 * A call's run is over, as pi's `tool_execution_end` says, after any
	 * answer it gave: one that never answered was refused before it ran.
	 */
	closed(toolCallId: string): void;
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
 * A background job judged by its whole command to only wait, by the
 * call that handed it off.
 */
export type WaitingCall = readonly [toolCallId: string, jobId: string];

/**
 * Heavy calls whose work is running, from `carried` on: the calls a
 * reload handed over from the runtime before, whose work runs on. The
 * jobs that only wait are kept in `waiting`, which the caller owns, so
 * a carry can read them.
 */
export function createHeavyCalls(
	heavy: (event: LeaseEvent) => void,
	why: (command: string) => string = whatOf,
	carried: readonly HeavyCall[] = [],
	waiting: Map<string, string> = new Map(),
): HeavyCalls {
	const calls = new Map<string, string>(carried);
	// Each command running, until it answers or hands off.
	const commands = new Map<string, string>();
	const background = (toolCallId: string, jobId: string, command: string) => {
		const subject = backgroundSubject(jobId, command);
		calls.set(toolCallId, subject);
		// Quiet: two sessions running the same script share job ids and
		// commands, and a note that both run at once would land in each
		// conversation as words its person never said.
		heavy({
			take: {
				subject,
				why: firstWords(command),
				ms: BACKGROUND_MS,
				quiet: true,
			},
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
				if (onlyWaits(command)) waiting.set(toolCallId, bareJob(jobId));
				else background(toolCallId, jobId, command);
			}
		},
		finished(toolCallId) {
			waiting.delete(toolCallId);
			ended(toolCallId);
		},
		closed(toolCallId) {
			// Answered, it was settled there, handed off or not.
			if (!commands.has(toolCallId)) return;
			commands.delete(toolCallId);
			ended(toolCallId);
		},
		takenUp(toolCallId, jobId, label) {
			if (ofKind(toolCallId, label) !== undefined) return;
			if (wholeWait(label)) waiting.set(toolCallId, bareJob(jobId));
			else if (!waiting.has(toolCallId)) background(toolCallId, jobId, label);
		},
		clear: () => {
			calls.clear();
			commands.clear();
			waiting.clear();
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

/** Where a reload leaves the jobs that only wait, as for the calls. */
const carriedWaits = () =>
	sessionSlot<WaitingCall[]>(
		"agentic-harness.mesh.waiting-calls.v1",
		undefined,
		() => [],
	);

/** Leave the jobs that only wait for the runtime a reload starts. */
export function parkWaitingCalls(waiting: ReadonlyMap<string, string>): void {
	const carried = carriedWaits();
	carried.splice(0, carried.length, ...waiting);
}

/** Take the jobs that only wait a reload left, once. */
export function takeWaitingCalls(): readonly WaitingCall[] {
	return carriedWaits().splice(0);
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
