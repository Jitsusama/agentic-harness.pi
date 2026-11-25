/**
 * Where a worker machine names its node's worker socket: the one thing
 * the fence and the worker link both read of it. It stands apart from
 * the link (`worker-link.ts`), so the fence, which every sandboxed
 * command loads, never loads the mesh's folder of messages with it; a
 * test that fakes the disk under the mesh then still sees the mesh read
 * through its fake.
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
