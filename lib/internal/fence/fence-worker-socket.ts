/**
 * The node's worker socket, the one socket of the mycelium node's a
 * fenced or strict command may reach, on a machine with no mesh of its
 * own, such as a cloud VM (`lib/mesh/worker-link.ts`). The fence empties
 * the runtime folder and Landlock refuses every socket it isn't told of,
 * so on S99IA2's VM trial (24 November) a strict start found no node at
 * all. The socket `MYCELIUM_WORKER_SOCKET` names is bound back read-only,
 * which a connect doesn't need written, and told to Landlock; the node
 * behind it judges what a worker may ask.
 *
 * Never the node's full socket, `work.sock`, which takes every ask the
 * person's own sessions make, whatever path names it; never a name the
 * fence keeps out (`NEVER_THROUGH`); never a link, which could be pointed
 * at either once bound; and never a path that isn't there as a socket's
 * file, or that a `..` or a doubled slash spells other than it is.
 */

import { basename, isAbsolute, join, normalize } from "node:path";
import { workerSocket } from "../../mesh/worker-link.ts";
import { NEVER_THROUGH } from "./fence.ts";
import { DISK, type Disk } from "./fence-disk.ts";

/** The name of the node's full socket, which no fence lets through. */
const NODE_SOCKET = "work.sock";

/**
 * The worker socket a fenced command in `env` may reach, or none: none
 * where the machine names none, or names one the fence won't let through.
 */
export function fencedWorkerSocket(
	env: NodeJS.ProcessEnv,
	disk: Disk = DISK,
): string | undefined {
	const named = workerSocket(env);
	if (named === undefined) return undefined;
	if (normalize(named) !== named || basename(named) === NODE_SOCKET) {
		return undefined;
	}
	if (keptOut(named, env.XDG_RUNTIME_DIR)) return undefined;
	return disk.kind(named) === "file" ? named : undefined;
}

/**
 * Whether `path` is, or lies in, a name the fence keeps out, read from the
 * runtime folder `runtimeDir` where it isn't absolute, a trailing `*`
 * standing for any name it begins.
 */
function keptOut(path: string, runtimeDir: string | undefined): boolean {
	return NEVER_THROUGH.some((name) => {
		const whole = isAbsolute(name)
			? name
			: runtimeDir
				? join(runtimeDir, name)
				: undefined;
		if (whole === undefined) return false;
		return whole.endsWith("*")
			? path.startsWith(whole.slice(0, -1))
			: path === whole || path.startsWith(`${whole}/`);
	});
}
