/**
 * The sessions this process has switched away from, which must never
 * act again in it.
 *
 * pi disposes a session it switches away from, yet on 3 November one
 * that rolled over at 04:44Z was started again in the same process
 * later that morning, every time the live session reloaded: its
 * extensions ran their start on the old log, its mesh caught up on 13
 * messages the live session never got, and it started runs whose turns
 * pi could not save, printing "turn_end could not resolve the persisted
 * assistant entry ID" in the window until the process ended. Whatever
 * starts it, a session named here is one this process has left, and an
 * extension starting on it stands down.
 *
 * Held on the process rather than a module, since a reload loads every
 * module afresh and the mark has to outlive it.
 */

const LEFT_KEY = Symbol.for("agentic-harness.session.left");

type LeftGlobal = { [LEFT_KEY]?: Set<string> };

/** The process's one set, made on first use. */
function leftSessions(): Set<string> {
	const global = globalThis as LeftGlobal;
	global[LEFT_KEY] ??= new Set();
	return global[LEFT_KEY];
}

/** Mark `sessionId` as left by this process, before switching away from it. */
export function leaveSession(sessionId: string): void {
	leftSessions().add(sessionId);
}

/** Take back a mark, when the switch it was made for was called off. */
export function stayInSession(sessionId: string): void {
	leftSessions().delete(sessionId);
}

/** Whether this process has switched away from `sessionId`. */
export function sessionLeft(sessionId: string): boolean {
	return leftSessions().has(sessionId);
}
