/**
 * Where every pi process keeps node's compile cache: a folder of pi's
 * state, which the fence holds read-only. node reads a cached entry
 * back as compiled code at its next start, outside the fence, so a
 * cache a fenced command could write would run its code there. Left to
 * itself, node keeps the cache in the temporary folder, which is either
 * the real `/tmp` or, for a session on a quest, a folder inside the
 * quest's scratch that the fence lets that session write (04TNWT, 19
 * November).
 */

import type { SessionEnvironment } from "../../core/session/host.ts";
import { stateDir } from "../paths.ts";

/** The variable node reads its compile cache's folder from. */
export const COMPILE_CACHE_VARIABLE = "NODE_COMPILE_CACHE";

/** The folder in pi's state that every pi process compiles into. */
export function compileCacheFolder(): string {
	return stateDir("node-compile-cache");
}

/**
 * Point node's compile cache in `env` at pi's state, so every pi this
 * process starts, whatever its temporary folder, compiles there.
 */
export function keepCompileCacheOutOfReach(
	env: Pick<SessionEnvironment, "set">,
): void {
	env.set(COMPILE_CACHE_VARIABLE, compileCacheFolder());
}
