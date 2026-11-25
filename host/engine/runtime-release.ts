/**
 * How a host lets go of a conversation's pi runtime: closed for good, or
 * left for the next host to carry on. pi 1.6's dispose first aborts the
 * session and waits for its run to settle, which a parked agent never
 * does while a tool it carries runs on, so every conversation mid-tool
 * held a stop to its bound. Every ending but a close leaves the run as
 * it stands (a park, a host's stop or restart), through the leaveRun
 * the host's runtime patch (pi-host-park-leaves-its-run) gives dispose.
 * A pi without it ignores the option, which is right for 1.5, whose
 * dispose aborts nothing; on 1.6 the host reports it lacking.
 */

import type { AgentSessionRuntime } from "./pi-session.ts";

/** How a conversation's host said it ended: closed for good, signalled away, or neither yet. */
export type RuntimeEnding = "signalled" | "closed" | undefined;

/** Whether a conversation ending so leaves its run for the next host, rather than ending it. */
export function leavesItsRun(ending: RuntimeEnding): boolean {
	return ending !== "closed";
}

/** Dispose a conversation's runtime, leaving its run where the ending says to. */
export async function disposeRuntime(
	runtime: Pick<AgentSessionRuntime, "dispose">,
	ending: RuntimeEnding,
): Promise<void> {
	await runtime.dispose(leavesItsRun(ending) ? { leaveRun: true } : undefined);
}
