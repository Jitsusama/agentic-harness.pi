/**
 * Who other sessions are waiting on, as the mesh tells the queue.
 *
 * The queue's one preference beyond memory and age: heavy work of a
 * session another is parked on goes first, since finishing it is what
 * lets the parked sessions carry on. The queue knows jobs and the mesh
 * knows who waits on whom, so the mesh tells the queue here, where each
 * extension's copy of this module finds the same answer, as turn.ts
 * hands the queue to the shell. With no mesh, nobody is waited on.
 */

const AWAITED = Symbol.for("agentic-harness.priority.awaited");

type Holder = { [AWAITED]?: () => ReadonlySet<string> };

/** Nobody waited on. */
export const NOBODY: ReadonlySet<string> = new Set();

/** Tells the queue who is waited on from now on; the answer undoes it. */
export function tellAwaited(awaited: () => ReadonlySet<string>): () => void {
	const holder = globalThis as Holder;
	holder[AWAITED] = awaited;
	return () => {
		if (holder[AWAITED] === awaited) delete holder[AWAITED];
	};
}

/** The sessions waited on now, by session id. */
export function awaitedNow(): ReadonlySet<string> {
	try {
		return (globalThis as Holder)[AWAITED]?.() ?? NOBODY;
	} catch {
		// Who waits never holds up the queue.
		return NOBODY;
	}
}
