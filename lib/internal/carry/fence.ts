/**
 * The fence a session's commands ran under, carried with it so it
 * arrives under the same one: a move never loosens a cell (5HJZ8Z
 * [ca195127], 16 November).
 *
 * `pi-carry arrive` says it on its last line rather than judging it,
 * since the mycelium node starts the arriving pi, sets its `PI_SANDBOX`
 * and refuses a machine whose fence can't hold it (KP0L6A [35567865]);
 * a done file naming a kind no harness knows doesn't read at all.
 */

import type { FenceKind } from "../../mesh/presence.ts";
import { OFF } from "../fence-stage.ts";
import { SANDBOX_NAMES, STRICT, sandboxName } from "../sandbox.ts";

/** Every kind a done file may name. */
const FENCE_KINDS: readonly FenceKind[] = ["none", "fence", "strict"];

/**
 * How a session with this environment fences its commands: the sandbox
 * its `PI_SANDBOX` asks for (the first stage's fence included), or
 * `none`. Its presence says the same for mycelium to match against.
 */
export function fenceKindOf(env: NodeJS.ProcessEnv): FenceKind {
	const name = sandboxName(env);
	if (name === STRICT) return "strict";
	if (name === SANDBOX_NAMES.fence) return "fence";
	return "none";
}

/**
 * What `PI_SANDBOX` is set to for a session to start under `kind`:
 * `off` for one that ran unfenced, never `none`, which names no sandbox
 * and so reads as the fence.
 */
export function sandboxAsking(kind: FenceKind): string {
	return kind === "none" ? OFF : kind;
}

/** Whether a done file's field names a fence kind. */
export function isFenceKind(value: unknown): value is FenceKind {
	return FENCE_KINDS.some((kind) => kind === value);
}
