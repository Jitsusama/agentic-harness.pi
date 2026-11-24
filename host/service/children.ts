/**
 * Conversations a child process runs, as the host reaches them.
 *
 * Every conversation a host ran shared its one JavaScript thread, so
 * whatever one of them did there held all of them: a collection, a
 * synchronous read of its store, a walk of a folder. On 19 November the
 * background host ran 88 on that thread and its loop held 5 s or more
 * 623 times in two days, three times past two minutes. A conversation
 * moved into a child runs on the child's thread alone, so nothing it
 * does can hold another.
 *
 * The host keeps its key, socket, roster and stores, so nothing outside
 * it learns of children: a window still attaches to the host, and a
 * release or close still names it, or names the child that runs the
 * conversation, as the machine's registry does. The host passes each
 * request for a conversation a child runs on to that child's own
 * socket, naming the
 * child as the host it expects, and hands a viewer's connection over
 * whole once the request is passed on, so the child's frames and the
 * window's keys go through as bytes, decoded on neither side's behalf
 * by the host's thread.
 */

import { startTicksFromProc } from "../../lib/internal/process-ticks.ts";
import { settledWithin } from "../../lib/internal/settled.ts";
import { pssBytesOf } from "../engine/quiet-collection.ts";
import type { ControlBackend, HostIdentity } from "./dispatch.ts";
import type {
	ControlRequest,
	Measured,
	MemoryAnswer,
	SessionIdentity,
} from "./protocol.ts";

/** Where the child running one conversation answers, and who it is. */
export interface ChildRoute {
	/** The child's control socket, an absolute path. */
	readonly socket: string;
	/** The child's own identity, which a request passed on names. */
	readonly identity: HostIdentity;
}

/** A heap as a child's V8 said it, in bytes. */
export interface HeapSaid {
	readonly used: number;
	readonly limit: number;
}

/** One conversation a child runs, with the heap it last said. */
export interface HeldChild {
	readonly conversation: SessionIdentity;
	readonly route: ChildRoute;
	/** Its last heap, and when the host heard it; absent until one is said. */
	readonly heap?: NonNullable<Measured["heap"]>;
}

/** The conversations children run, as the host's control listener reads them. */
export interface ChildRoutes {
	/** The child running a conversation, or nothing while the host runs it. */
	routeOf(sessionId: string): ChildRoute | undefined;
	/** Each conversation a child runs, as a list names it. */
	listed(): readonly SessionIdentity[];
	/** Each conversation a child runs, with its route and last heap. */
	held(): readonly HeldChild[];
	/** The child running a conversation, with its last heap, or nothing. */
	child(sessionId: string): HeldChild | undefined;
}

/** The routes, kept as children start, change and end. */
export interface HeldChildren extends ChildRoutes {
	/**
	 * A child runs `conversation` now, answering at `route`, with the heap
	 * it last said where it is the same child under another conversation.
	 */
	hold(
		conversation: SessionIdentity,
		route: ChildRoute,
		heap?: HeldChild["heap"],
	): void;
	/**
	 * The child's conversation changed state, as the child said, with its
	 * heap when the line carried one; a line without keeps the last.
	 */
	update(conversation: SessionIdentity, heap?: HeapSaid): void;
	/** No child runs the conversation any longer. */
	drop(sessionId: string): void;
}

/** An empty set of routes, filled as children start; `now` dates each heap heard. */
export function heldChildren(now: () => Date = () => new Date()): HeldChildren {
	const held = new Map<string, HeldChild>();
	return {
		routeOf: (sessionId) => held.get(sessionId)?.route,
		listed: () => [...held.values()].map(({ conversation }) => conversation),
		held: () => [...held.values()],
		child: (sessionId) => held.get(sessionId),
		hold(conversation, route, heap) {
			held.set(conversation.sessionId, {
				conversation,
				route,
				...(heap ? { heap } : {}),
			});
		},
		update(conversation, heap) {
			const was = held.get(conversation.sessionId);
			if (!was) return;
			held.set(conversation.sessionId, {
				...was,
				conversation,
				...(heap
					? {
							heap: {
								used: heap.used,
								limit: heap.limit,
								at: now().toISOString(),
							},
						}
					: {}),
			});
		},
		drop(sessionId) {
			held.delete(sessionId);
		},
	};
}

/**
 * The request as the child takes it: the host checked the identity the
 * caller expected against its own and this child's, so the child is
 * asked under its own.
 */
export function passedOn(
	request: ControlRequest,
	route: ChildRoute,
): ControlRequest {
	return request.expectedHost
		? { ...request, expectedHost: route.identity }
		: request;
}

/**
 * A child's Pss in bytes, read as asked rather than reported, since its
 * heap hides most of it: in #2104's lane a collected child held 327 MB
 * beside 112 MB of heap. Nothing once its pid is gone, taken by a process
 * that started at another tick, or named without ticks to tell, so
 * another process's memory is never reported as the child's. The ticks
 * are read after the Pss, so a pid taken between the two reads is caught
 * too. The Pss is read off the host's thread, one child at a time, as
 * hostProcReads reads it; the ticks are read at once, since the kernel answers
 * a process's stat without the lock its mappings are walked under.
 */
export async function childPss(
	owner: HostIdentity["owner"],
	proc: ProcReads = hostProcReads,
): Promise<number | undefined> {
	const pss = await proc.pss(owner.pid);
	if (pss === undefined || owner.startTicks === undefined) return undefined;
	return (await proc.startTicks(owner.pid)) === owner.startTicks
		? pss
		: undefined;
}

/**
 * How long a memory answer waits on a Pss, the host's or a child's: well
 * within the 30 s a client waits on the answer, and long past the
 * milliseconds a read takes when nothing holds it up.
 */
export const PSS_WAIT_MS = 5_000;

/**
 * Reads through `read` one at a time, a pid's read in progress given to
 * each caller that asks for that pid meanwhile. The kernel walks a
 * process's mappings for its Pss under the process's lock, so a child
 * held up under memory pressure holds its read up too, on one of the
 * few threads libuv shares with the host's file reads; this way it holds
 * one, however often memory is asked for, and the host's own reads go on.
 * Each caller awaiting a read that never ends would be kept for as long
 * as it lasts, so past `waitMs` a caller has nothing at once: one whose
 * pid's read has been pending that long, and one whose pid would queue
 * behind a read that has been running that long. Only the pids asked
 * for within the wait stay queued behind it. The wait is timed on a
 * clock that only moves forward, so a step of the wall clock neither
 * shortens it nor brings back the sharing.
 */
export function oneReadAtOnce(
	read: (pid: number) => Promise<number | undefined>,
	waitMs = PSS_WAIT_MS,
	now: () => number = () => performance.now(),
): (pid: number) => Promise<number | undefined> {
	const reading = new Map<
		number,
		{ readonly read: Promise<number | undefined>; readonly since: number }
	>();
	let last: Promise<unknown> = Promise.resolve();
	// When the read in progress began, while one is.
	let runningSince: number | undefined;
	return (pid) => {
		const under = reading.get(pid);
		if (under) {
			return now() - under.since < waitMs
				? under.read
				: Promise.resolve(undefined);
		}
		if (runningSince !== undefined && now() - runningSince >= waitMs) {
			return Promise.resolve(undefined);
		}
		const next = last
			.then(() => {
				runningSince = now();
				return read(pid);
			})
			.finally(() => {
				runningSince = undefined;
				reading.delete(pid);
			});
		reading.set(pid, { read: next, since: now() });
		last = next.catch(() => {
			// Its caller hears the failure; the next read goes on regardless.
		});
		return next;
	};
}

/** What childPss reads of a process from procfs, each nothing where unread. */
export interface ProcReads {
	readonly pss: (pid: number) => Promise<number | undefined>;
	readonly startTicks: (pid: number) => Promise<number | undefined>;
}

/** The host's own reads of its children, their Pss one at a time for the whole host. */
export const hostProcReads: ProcReads = {
	pss: oneReadAtOnce(pssBytesOf),
	startTicks: startTicksFromProc,
};

/** How a memory answer reads a child's Pss, nothing where it can't be had. */
export type ReadPss = (
	owner: HostIdentity["owner"],
) => Promise<number | undefined>;

/** One child's entry in a memory answer, each reading absent where unread. */
async function childMemory(
	child: HeldChild,
	pss: ReadPss,
	waitMs: number,
): Promise<MemoryAnswer["sessions"][number]> {
	const read = await settledWithin(pss(child.route.identity.owner), waitMs);
	return {
		sessionId: child.conversation.sessionId,
		state: child.conversation.state,
		...(child.heap ? { heap: child.heap } : {}),
		...(read === undefined ? {} : { pss: read }),
	};
}

/** Whether a list or memory result carries the sessions the host itself runs. */
function isListResult(
	value: unknown,
): value is { sessions: SessionIdentity[]; host: HostIdentity } {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray(Reflect.get(value, "sessions"))
	);
}

/**
 * The host's backend with its children's conversations in every list
 * and memory answer, so a caller reading what the host holds sees them
 * all, whichever thread runs each. A conversation in both, as while a
 * child takes one up, is named once, by its child. Memory gives each
 * child's last heap and its Pss, read through `pss` as the answer is
 * made. A Pss not read within `waitMs`, as a child's held up under memory
 * pressure and those queued behind it, is answered as unread, so one
 * stuck child never withholds the rest of the answer.
 */
export function listingChildren(
	backend: ControlBackend,
	children: ChildRoutes,
	pss: ReadPss = childPss,
	waitMs = PSS_WAIT_MS,
): ControlBackend {
	return {
		identity: backend.identity,
		async execute(request) {
			const result = await backend.execute(request);
			if (request.op !== "list" && request.op !== "memory") return result;
			if (!isListResult(result)) return result;
			const held = children.held();
			const moved = new Set(
				held.map(({ conversation }) => conversation.sessionId),
			);
			const ours = result.sessions.filter(
				({ sessionId }) => !moved.has(sessionId),
			);
			const theirs =
				request.op === "list"
					? held.map(({ conversation }) => conversation)
					: await Promise.all(
							held.map((child) => childMemory(child, pss, waitMs)),
						);
			return { ...result, sessions: [...ours, ...theirs] };
		},
	};
}
