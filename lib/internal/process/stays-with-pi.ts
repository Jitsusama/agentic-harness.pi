/**
 * Marking a spawn as one that stays where pi is, out of the cgroup the
 * priority workflow places children in (`priority/place.ts`).
 *
 * It lives apart from the placing, so a helper that only needs to stay
 * with pi, as the call probe does, depends on this alone rather than on
 * the priority workflow, which itself asks that probe about calls.
 *
 * The mark is a count on `ChildProcess.prototype`, under a symbol every
 * copy of this module shares: the spawn wrapper is installed once a
 * process and outlives a reload, and the wrapper an older load left there
 * reads the mark by the same symbol.
 */

import { ChildProcess } from "node:child_process";

/**
 * How many {@link withPi} calls are under way, on the prototype every
 * copy shares. Keep the name as it is, `priority` and all: a wrapper an
 * older load left reads it as written there.
 */
const STAYING = Symbol.for("agentic-harness.priority.staying");

interface Marked {
	[STAYING]?: number;
}

const marked = () => ChildProcess.prototype as unknown as Marked;

/**
 * Runs `spawning`, leaving whatever it spawns where pi is rather than in
 * jobs. For a helper pi keeps for its own screen, as the status line's
 * git engine is: placed in jobs, it starved behind the builds there and
 * the footer lagged whenever the machine was busy. Or for what must stay
 * in its unit, as a host's systemd-notify does, since systemd credits a
 * notify to the cgroup its sender is in. Only what is spawned
 * synchronously inside counts, since spawn itself is synchronous.
 */
export function withPi<T>(spawning: () => T): T {
	const prototype = marked();
	prototype[STAYING] = (prototype[STAYING] ?? 0) + 1;
	try {
		return spawning();
	} finally {
		prototype[STAYING] = (prototype[STAYING] ?? 1) - 1;
	}
}

/** Whether a spawn made now is inside {@link withPi}. */
export function stayingWithPi(): boolean {
	return (marked()[STAYING] ?? 0) > 0;
}
