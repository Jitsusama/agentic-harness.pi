/**
 * A signal that fires once a wall clock runs out or the caller's own
 * signal fires, whichever is first, made from a plain AbortController
 * and a timer rather than from `AbortSignal.timeout`.
 *
 * Node keeps a set of the signals it must not let be collected: a
 * timeout signal, and a composite one from `AbortSignal.any` that may
 * still fire. A composite with a timeout signal among its sources goes
 * into that set as it is made. When another source aborts it, node 22
 * leaves it there for good, because it lets go only of the source that
 * aborted, and the composite's last way out, every source collected,
 * never comes. The `DOMException` that a bare `abort()` makes keeps
 * that source's controller in its stack frames, and the composite keeps
 * that reason. So each one keeps whatever those frames held: the agent,
 * its session and the extension runner of the moment, so one made
 * before a reload keeps that whole runner. One pi of 88 hours held 164
 * of its 475 MiB this way, in 18 of them, each over a run a
 * compaction stopped. Node 24 lets them go.
 *
 * A plain controller's signal is never in that set, so nothing built
 * on one is held past its listeners. And the reason given when the
 * clock runs out has its stack written out at once, so it holds no
 * frames either.
 */

import { WallClockExceeded } from "./bound.ts";

/** A clock over some work, and the signal that says it ran out. */
export interface Deadline {
	/** Fires when the clock runs out or the followed signal fires. */
	readonly signal: AbortSignal;
	/** Whether it was the clock that fired, not the followed signal. */
	readonly expired: boolean;
	/** Stops the clock and stops following, once the work is done. */
	end(): void;
}

/**
 * A deadline `wallMs` from now for `what`, a phrase such as "the
 * advisor's review", following `follows` if given: it fires with that
 * signal's own reason, at once if it has already fired. Either firing
 * ends the deadline by itself, so one a caller never ends holds its
 * timer and its listener only until its clock runs out.
 */
export function deadline(
	wallMs: number,
	what: string,
	follows?: AbortSignal,
): Deadline {
	const controller = new AbortController();
	let expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function end(): void {
		clearTimeout(timer);
		follows?.removeEventListener("abort", followed);
	}
	function followed(): void {
		end();
		controller.abort(follows?.reason);
	}
	if (follows?.aborted) {
		controller.abort(follows.reason);
	} else {
		timer = setTimeout(() => {
			expired = true;
			end();
			const reason = new WallClockExceeded(what, wallMs);
			// Written out now, so the reason holds a string rather
			// than the frames it was made in.
			void reason.stack;
			controller.abort(reason);
		}, wallMs);
		// As node's own timeout signal does, so a clock alone never
		// keeps the process up.
		timer.unref();
		follows?.addEventListener("abort", followed, { once: true });
	}
	return {
		signal: controller.signal,
		get expired() {
			return expired;
		},
		end,
	};
}
