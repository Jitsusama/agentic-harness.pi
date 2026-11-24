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

import { startTicksFromProcSync } from "../../lib/internal/process-ticks.ts";
import { pssBytes } from "../engine/quiet-collection.ts";
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
 * too.
 */
export function childPss(
	owner: HostIdentity["owner"],
	proc: ProcReads = { pss: pssBytes, startTicks: startTicksFromProcSync },
): number | undefined {
	const pss = proc.pss(owner.pid);
	if (pss === undefined || owner.startTicks === undefined) return undefined;
	return proc.startTicks(owner.pid) === owner.startTicks ? pss : undefined;
}

/** What childPss reads of a process from procfs, each nothing where unread. */
export interface ProcReads {
	readonly pss: (pid: number) => number | undefined;
	readonly startTicks: (pid: number) => number | undefined;
}

/** One child's entry in a memory answer, each reading absent where unread. */
function childMemory(
	child: HeldChild,
	pss: (owner: HostIdentity["owner"]) => number | undefined,
): MemoryAnswer["sessions"][number] {
	const read = pss(child.route.identity.owner);
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
 * made.
 */
export function listingChildren(
	backend: ControlBackend,
	children: ChildRoutes,
	pss: (owner: HostIdentity["owner"]) => number | undefined = childPss,
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
					: held.map((child) => childMemory(child, pss));
			return { ...result, sessions: [...ours, ...theirs] };
		},
	};
}
