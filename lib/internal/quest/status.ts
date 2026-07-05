/**
 * Quest status liveness, in one place so every reader agrees on what
 * "sealed" means. A sealed quest (concluded or retired) is finished:
 * it sorts after live work, is excluded from reorders, and drops its
 * live priority on the seal cascade.
 */

const SEALED_STATUSES = new Set(["concluded", "retired"]);

/** True when the status marks a finished quest (concluded or retired). */
export function isSealedStatus(status: string | undefined): boolean {
	return status !== undefined && SEALED_STATUSES.has(status);
}

/** True when the quest is still live (any status that is not sealed). */
export function isLiveStatus(status: string | undefined): boolean {
	return !isSealedStatus(status);
}
