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
 * release or close still names it. The host passes each request for a
 * conversation a child runs on to that child's own socket, naming the
 * child as the host it expects, and hands a viewer's connection over
 * whole once the request is passed on, so the child's frames and the
 * window's keys go through as bytes, decoded on neither side's behalf
 * by the host's thread.
 */

import type { ControlBackend, HostIdentity } from "./dispatch.ts";
import type { ControlRequest, SessionIdentity } from "./protocol.ts";

/** Where the child running one conversation answers, and who it is. */
export interface ChildRoute {
	/** The child's control socket, an absolute path. */
	readonly socket: string;
	/** The child's own identity, which a request passed on names. */
	readonly identity: HostIdentity;
}

/** The conversations children run, as the host's control listener reads them. */
export interface ChildRoutes {
	/** The child running a conversation, or nothing while the host runs it. */
	routeOf(sessionId: string): ChildRoute | undefined;
	/** Each conversation a child runs, as a list names it. */
	listed(): readonly SessionIdentity[];
}

/** The routes, kept as children start, change and end. */
export interface HeldChildren extends ChildRoutes {
	/** A child runs `conversation` now, answering at `route`. */
	hold(conversation: SessionIdentity, route: ChildRoute): void;
	/** The child's conversation changed state, as the child said. */
	update(conversation: SessionIdentity): void;
	/** No child runs the conversation any longer. */
	drop(sessionId: string): void;
}

/** An empty set of routes, filled as children start. */
export function heldChildren(): HeldChildren {
	const held = new Map<
		string,
		{ conversation: SessionIdentity; route: ChildRoute }
	>();
	return {
		routeOf: (sessionId) => held.get(sessionId)?.route,
		listed: () => [...held.values()].map(({ conversation }) => conversation),
		hold(conversation, route) {
			held.set(conversation.sessionId, { conversation, route });
		},
		update(conversation) {
			const was = held.get(conversation.sessionId);
			if (was) held.set(conversation.sessionId, { ...was, conversation });
		},
		drop(sessionId) {
			held.delete(sessionId);
		},
	};
}

/**
 * The request as the child takes it: the host checked the identity the
 * caller expected against its own and the child's, so the child is asked
 * under its own.
 */
export function passedOn(
	request: ControlRequest,
	route: ChildRoute,
): ControlRequest {
	return request.expectedHost
		? { ...request, expectedHost: route.identity }
		: request;
}

/** Whether a list result carries the sessions the host itself runs. */
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
 * The host's backend with its children's conversations in every list,
 * so a caller reading what the host holds sees them all, whichever
 * thread runs each. A conversation in both, as while a child takes one
 * up, is named once, by its child.
 */
export function listingChildren(
	backend: ControlBackend,
	children: ChildRoutes,
): ControlBackend {
	return {
		identity: backend.identity,
		async execute(request) {
			const result = await backend.execute(request);
			if (request.op !== "list" || !isListResult(result)) return result;
			const theirs = children.listed();
			const moved = new Set(theirs.map(({ sessionId }) => sessionId));
			return {
				...result,
				sessions: [
					...result.sessions.filter(({ sessionId }) => !moved.has(sessionId)),
					...theirs,
				],
			};
		},
	};
}
