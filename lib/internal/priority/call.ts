/**
 * Whether the person is on a call on this machine, as `a-call-is-on
 * --here` says by its exit: 0 a call is on, 1 none. While one is on, the
 * queue starts only light work (next-turn.ts), since a call goes choppy
 * once heavy work loads the machine: Joel's at 09:39 on 23 November did
 * at a load of 119 to 127, and a test call at a load of 70 was clean
 * (1OGSE7). `--here` asks this machine alone, since work here hurts only
 * a call here. Anything else the probe says, or a probe that isn't there
 * or doesn't answer, reads as not knowing, which holds nothing, so a
 * broken probe can't stop all work; one that can never answer is said
 * once (calls/probe.ts), since the hold is off wherever it is.
 *
 * Each session asks for itself, at most every {@link CALL_READ_MS}: the
 * queue's keeping passes between sessions, so one keeping it now may not
 * have read the call for a while. The probe runs in the background once
 * a session has an answer, so a slow probe never holds a keep or a
 * heavy command up.
 */

import { askCall } from "../calls/probe.ts";

/** How long an answer stands before a keep asks again. */
export const CALL_READ_MS = 15_000;

/** How long the probe may take, which it does in a tenth of a second. */
export const CALL_PROBE_MS = 5_000;

/**
 * How long a call stays on through probes that can't say, since a probe
 * is slowest when the machine is busiest: a timeout then mustn't let
 * heavy work start in the middle of the call.
 */
export const CALL_KEPT_MS = 60_000;

/** Whether a call is on, or nothing where that can't be said. */
export type CallProbe = () => Promise<boolean | undefined>;

/**
 * Asks `a-call-is-on --here` whether the person is on a call here.
 * `cannotAsk` hears, once, why it can't be asked at all.
 */
export function probeCall(
	cannotAsk?: (why: string) => void,
): Promise<boolean | undefined> {
	return askCall({ args: ["--here"], timeoutMs: CALL_PROBE_MS, cannotAsk });
}

/** `reading`, marked while `call` says the person is on a call here. */
export async function onCallIf<T extends { readonly onCall?: boolean }>(
	call: CallProbe,
	reading: T,
): Promise<T> {
	return (await call()) === true ? { ...reading, onCall: true } : reading;
}

/**
 * Reads the call through `probe`, asking again once the last answer is
 * {@link CALL_READ_MS} old and sharing one probe in flight among the
 * keeps asking meanwhile. Only a session's first read waits on the
 * probe; after it, a read answers at once from what is known, while a
 * fresh probe runs behind it. A call stays on through probes that can't
 * say until it is {@link CALL_KEPT_MS} past its last confirmation. A
 * probe that refuses reads as not knowing. Its clock is monotonic, so a
 * wall clock stepped back can't keep an old answer standing.
 */
export function callReader(
	probe: CallProbe = () => probeCall(),
	clock: () => number = () => performance.now(),
): CallProbe {
	let askedAt: number | undefined;
	let said: boolean | undefined;
	let onAt: number | undefined;
	let reading: Promise<boolean | undefined> | undefined;
	const known = (): boolean | undefined => {
		if (said !== undefined) return said;
		return onAt !== undefined && clock() - onAt < CALL_KEPT_MS
			? true
			: undefined;
	};
	const ask = (): Promise<boolean | undefined> => {
		reading ??= probe()
			.catch(() => undefined)
			.then((onCall) => {
				askedAt = clock();
				said = onCall;
				if (onCall === true) onAt = askedAt;
				if (onCall === false) onAt = undefined;
				reading = undefined;
				return known();
			});
		return reading;
	};
	return () => {
		if (askedAt === undefined) return ask();
		if (clock() - askedAt >= CALL_READ_MS) ask();
		return Promise.resolve(known());
	};
}
