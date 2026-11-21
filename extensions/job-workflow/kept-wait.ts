/**
 * A returning session's wait on its carried run, handed from the
 * runtime a reload ends to the one it starts. A hosted conversation
 * reloads itself whenever its install moves, at its first quiet moment,
 * which a session idle while its carried run waits its turn is; with
 * the wait half an hour long, a merge during a restart's catch-up would
 * otherwise drop it across every conversation still waiting.
 */

import { sessionCell } from "../../lib/core/session/index.ts";
import type { CutOff } from "../../lib/internal/session/cut-off-record.ts";

/** What a wait is, as a reload hands it on. */
export interface KeptWait {
	/** The cut-off found as the session returned. */
	readonly cut: CutOff;
	/** The branch's length as the session returned. */
	readonly since: number;
	/** When the wait's clock next tells, in ms since the epoch. */
	readonly endsAt: number;
	readonly started?: boolean;
	readonly typed?: boolean;
	/** Whether its last run was stopped short with none since; older runtimes leave it out. */
	readonly stopped?: boolean;
}

/**
 * Where a wait waits through a reload. The name and the shape kept
 * under it are what the runtime after reads, so a change to either
 * takes a new version.
 */
const KEPT = "agentic-harness.jobs.carried-wait.v1";

/** Leave `wait` for the runtime a reload of `session` starts. */
export function keepWait(session: string | undefined, wait: KeptWait): void {
	sessionCell<KeptWait>(KEPT, session).set(wait);
}

/** Take the wait a reload of `session` left, once, if one was. */
export function takeKeptWait(
	session: string | undefined,
): KeptWait | undefined {
	const cell = sessionCell<KeptWait>(KEPT, session);
	const kept = cell.get();
	cell.clear();
	return kept;
}
