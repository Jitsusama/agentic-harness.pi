/**
 * The fence a session's commands ran under, carried with it so it
 * arrives under the same one: a move never loosens a cell (5HJZ8Z
 * [ca195127], 16 November).
 *
 * The strict profile and the fence are fenced differently rather than
 * one more than the other, so a fenced session arrives only under its
 * own kind; one that ran unfenced may arrive under either.
 */

import type { FenceKind } from "../../mesh/presence.ts";
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

/** Whether a done file's field names a fence kind. */
export function isFenceKind(value: unknown): value is FenceKind {
	return FENCE_KINDS.some((kind) => kind === value);
}

/**
 * Why a session carried under `carried` can't arrive under `here`, or
 * nothing when it can.
 */
export function looserFence(
	carried: FenceKind,
	here: FenceKind,
): string | undefined {
	if (carried === "none" || carried === here) return undefined;
	return `It ran under PI_SANDBOX=${carried}, but would start here under ${here === "none" ? "no fence" : `PI_SANDBOX=${here}`}, and a move never changes a session's fence. Start it with PI_SANDBOX=${carried}.`;
}
