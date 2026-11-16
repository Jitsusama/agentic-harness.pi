/**
 * Kept calls timed from their turn, still carried by pi's own signal.
 *
 * A call the machine's queue holds has its time limit taken over by
 * timedFromTurn, which runs it below under a signal of its own and
 * without the limit. Keeping then knew the call only by that inner
 * signal and held no deadline for it, so the hand-off, asking with the
 * signal pi ran the call under, found nothing to carry: every queued
 * call with a limit held its session's move, and a host's restart, for
 * its whole run. And had it been carried, the turn's clock here would
 * still have stopped it at its limit, in a pi no longer holding it.
 *
 * So each timed call is remembered by pi's signal. Its carry is
 * keeping's, found by the inner signal, with the time left of the limit
 * as its deadline, and handing it on stops the clock here.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	type TimedCall,
	timedFromTurn,
} from "../../lib/internal/priority/clock.ts";
import type { JobCarry } from "../../lib/jobs/index.ts";
import type { Keeping } from "./keeping.ts";

/** timedFromTurn's options, less the one this module sets. */
type TimingOptions = Omit<
	NonNullable<Parameters<typeof timedFromTurn>[1]>,
	"onTimed"
>;

/**
 * `keeping`'s operations timed from their turn, with a carry for each
 * call found by the signal pi ran it under.
 */
export function timedKeeping(
	keeping: Keeping,
	options: TimingOptions & {
		/** What the kept operations run below, between keeping and timing. */
		around?: (ops: BashOperations) => BashOperations;
	} = {},
): Keeping {
	const { around, ...timing } = options;
	const timed = new WeakMap<AbortSignal, TimedCall>();
	const below = around ? around(keeping.operations) : keeping.operations;
	return {
		operations: timedFromTurn(below, {
			...timing,
			onTimed: (call) => timed.set(call.outer, call),
		}),
		carryOf(signal) {
			const call = timed.get(signal);
			const carry = keeping.carryOf(call?.inner ?? signal);
			return call && carry ? withClock(carry, call) : carry;
		},
	};
}

/** `carry`, saying the timed call's deadline and stopping its clock when handed. */
function withClock(carry: JobCarry, call: TimedCall): JobCarry {
	return {
		what() {
			const work = carry.what();
			if (!work || work.deadline !== undefined) return work;
			return { ...work, deadline: call.deadline() };
		},
		handed() {
			call.disarm();
			carry.handed();
		},
	};
}
