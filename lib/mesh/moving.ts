/**
 * Moving: a move a session's person asked, as its presence says it,
 * while it waits for the session to be free, and once it was called off
 * rather than made, why (extensions/mesh-workflow/moving.ts makes both).
 */

import { isRecord } from "../internal/record.ts";
import { isMoveTarget, type MoveTarget } from "../internal/session/move.ts";

/** A move waiting for its session to be free, as presence says it. */
export interface Moving {
	readonly to: MoveTarget;
	/** When it was asked, as an ISO time. */
	readonly since: string;
	/** What holds the session now; missing once nothing does. */
	readonly holds?: string;
}

/** A move called off rather than made, as presence says it. */
export interface MoveOff {
	readonly to: MoveTarget;
	/** When it was asked, as an ISO time. */
	readonly since: string;
	/** When it was called off, as an ISO time. */
	readonly at: string;
	/** Why, as its window said. */
	readonly why: string;
}

/** A move a presence says waits, or nothing when it says none this reads. */
export function movingFrom(value: unknown): Moving | undefined {
	if (!isRecord(value)) return undefined;
	const { to, since, holds } = value;
	if (!isMoveTarget(to) || typeof since !== "string") return undefined;
	return { to, since, ...(typeof holds === "string" ? { holds } : {}) };
}

/** A move a presence says was called off, or nothing it can read. */
export function moveOffFrom(value: unknown): MoveOff | undefined {
	if (!isRecord(value)) return undefined;
	const { to, since, at, why } = value;
	if (
		!isMoveTarget(to) ||
		typeof since !== "string" ||
		typeof at !== "string" ||
		typeof why !== "string"
	) {
		return undefined;
	}
	return { to, since, at, why };
}
