/**
 * Where a worker machine names its node's worker socket, apart from the
 * worker link that connects to it, so the fence can read the name
 * without loading the mesh's transport. Through the fence, the sandbox
 * reached the transport, and the transport bound `node:fs` before a test
 * could stand in for it, so a test's listings went unseen (42P0R4,
 * 24 November).
 */

import { isAbsolute } from "node:path";

/** The variable a worker machine names its node's worker socket in. */
export const WORKER_SOCKET_VARIABLE = "MYCELIUM_WORKER_SOCKET";

/**
 * The worker socket this machine names, or none: none where the variable
 * is unset, empty or not an absolute path, and the folder stands alone.
 */
export function workerSocket(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const named = env[WORKER_SOCKET_VARIABLE];
	return named && isAbsolute(named) ? named : undefined;
}
