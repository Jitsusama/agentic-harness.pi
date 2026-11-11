/**
 * Whether a screen has gates waiting on the person, read from what the
 * dock and the gate queue keep on it, for a reader that must not load pi.
 *
 * A host restarts only once every screen is at rest (host/screen), and a
 * gate the person hopped away from leaves pi's editor focused and empty
 * with nothing drawn over it, so only the dock still knows it waits. The
 * host runs under plain node, where pi's packages don't resolve, so it
 * can't load the dock or the queue themselves; this module reads their
 * shared state by the names they keep it under, which are theirs to use
 * from here, and installs nothing.
 */

import { isRecord } from "../internal/record.ts";
import { screenValue } from "./screen-slot.ts";

/** The name every copy of the dock looks for. The string is the contract; keep it. */
export const DOCK_NAME = "agentic-harness.dock";

/** The name every copy of the gate queue looks for. The string is the contract; keep it. */
export const QUEUE_NAME = "agentic-harness.gate-queue";

/**
 * How many gates this screen has docked. Each waits on a decision
 * wherever focus is.
 */
export function gatesDocked(): number {
	const dock = screenValue(DOCK_NAME);
	if (!isRecord(dock)) return 0;
	const entries: unknown = dock.entries;
	return Array.isArray(entries)
		? entries.filter((one) => isRecord(one) && one.gate === true).length
		: 0;
}

/**
 * How many gates hold this screen or wait in line for it. A queue from
 * before version 2 can't say and reads as none: a gate it shows still
 * shows in the dock or in pi's focus.
 */
export function gatesWaiting(): number {
	const queue = screenValue(QUEUE_NAME);
	if (!isRecord(queue) || typeof queue.waiting !== "function") return 0;
	const waiting: unknown = Reflect.apply(queue.waiting, queue, []);
	return typeof waiting === "number" ? waiting : 0;
}
