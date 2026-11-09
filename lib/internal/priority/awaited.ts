/**
 * Who other sessions are waiting on, as the mesh tells the queue.
 *
 * The queue's one preference beyond memory and age: heavy work of a
 * session another is parked on goes first, since finishing it is what
 * lets the parked sessions carry on. The queue knows jobs and the mesh
 * knows who waits on whom, so the mesh tells the queue here, where each
 * extension's copy of this module finds the same answer, as turn.ts
 * hands the queue to the shell. With no mesh, nobody is waited on.
 *
 * Every peer in the process tells: one on plain pi, one per conversation
 * on a host. Each answers for the whole machine, so the answer is all of
 * theirs together, and one peer going takes back only its own. The queue
 * asks as it is kept, from a timer as well as a call, so the tellers are
 * the process's rather than any one conversation's.
 */

import { processGlobal } from "../process-global.ts";

type Teller = () => ReadonlySet<string>;

function tellers(): Set<Teller> {
	return processGlobal(
		"agentic-harness.priority.awaited.tellers",
		() => new Set(),
	);
}

/** Nobody waited on. */
export const NOBODY: ReadonlySet<string> = new Set();

/** Tells the queue who is waited on from now on; the answer undoes it. */
export function tellAwaited(awaited: Teller): () => void {
	const all = tellers();
	all.add(awaited);
	return () => {
		all.delete(awaited);
	};
}

/** The sessions waited on now, by session id. */
export function awaitedNow(): ReadonlySet<string> {
	const all = tellers();
	if (all.size === 0) return NOBODY;
	const waited = new Set<string>();
	for (const teller of all) {
		try {
			for (const session of teller()) waited.add(session);
		} catch {
			// Who waits never holds up the queue: one teller failing leaves
			// the others' answers.
		}
	}
	return waited.size === 0 ? NOBODY : waited;
}
