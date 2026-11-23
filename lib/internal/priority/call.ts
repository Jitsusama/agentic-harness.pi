/**
 * Whether the person is on a call on this machine, as `a-call-is-on
 * --here` says by its exit: 0 a call is on, 1 none. While one is on, the
 * queue starts only light work (next-turn.ts), since a call goes choppy
 * once heavy work loads the machine: Joel's at 09:39 on 23 November did
 * at a load of 119 to 127, and a test call at a load of 70 was clean
 * (1OGSE7). `--here` asks this machine alone, since work here hurts only
 * a call here. Anything else the probe says, or a probe that isn't there
 * or doesn't answer, reads as not knowing, which holds nothing, so a
 * broken probe can't stop all work.
 *
 * Each session asks for itself, at most every {@link CALL_READ_MS}: the
 * queue's keeping passes between sessions, so one keeping it now may not
 * have read the call for a while. The probe runs where pi does rather
 * than among the jobs it would hold back, where it starved behind them.
 */

import { spawn } from "node:child_process";
import { withPi } from "./place.ts";

/** How long an answer stands before a keep asks again. */
export const CALL_READ_MS = 15_000;

/** How long the probe may take, which it does in a tenth of a second. */
export const CALL_PROBE_MS = 5_000;

/** Whether a call is on, or nothing where that can't be said. */
export type CallProbe = () => Promise<boolean | undefined>;

/**
 * What a call probe says by its exit: true for 0, false for 1, and
 * nothing for any other exit, a program that can't start, or one that
 * outlasts `timeoutMs`. The answer comes by its own timer, not the
 * probe's exit, and the probe is killed outright: one that ignored a
 * polite stop would otherwise hold every keep and heavy command
 * waiting on it.
 */
export function probeCall(
	program = "a-call-is-on",
	args: readonly string[] = ["--here"],
	timeoutMs = CALL_PROBE_MS,
): Promise<boolean | undefined> {
	return new Promise((resolve) => {
		const child = withPi(() => spawn(program, args, { stdio: "ignore" }));
		const late = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(undefined);
		}, timeoutMs);
		late.unref();
		const answer = (onCall: boolean | undefined) => {
			clearTimeout(late);
			resolve(onCall);
		};
		child.once("error", () => answer(undefined));
		child.once("exit", (code) =>
			answer(code === 0 ? true : code === 1 ? false : undefined),
		);
	});
}

/**
 * Reads the call through `probe`, answering from the last answer while
 * it is younger than {@link CALL_READ_MS} and sharing one probe in
 * flight among the keeps asking meanwhile. A probe that refuses reads as
 * not knowing. Its clock is monotonic, so a wall clock stepped back
 * can't keep an old answer standing.
 */
export function callReader(
	probe: CallProbe = () => probeCall(),
	clock: () => number = () => performance.now(),
): CallProbe {
	let last: { readonly at: number; readonly onCall?: boolean } | undefined;
	let reading: Promise<boolean | undefined> | undefined;
	return () => {
		if (last !== undefined && clock() - last.at < CALL_READ_MS) {
			return Promise.resolve(last.onCall);
		}
		reading ??= probe()
			.catch(() => undefined)
			.then((onCall) => {
				last = { at: clock(), ...(onCall === undefined ? {} : { onCall }) };
				reading = undefined;
				return onCall;
			});
		return reading;
	};
}
