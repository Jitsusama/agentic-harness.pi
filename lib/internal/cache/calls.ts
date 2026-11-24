/**
 * Whether a call is on, for work that would cut into one, such as a
 * cache warm that sends a whole conversation up the line. It asks
 * `a-call-is-on` the shared way (calls/probe.ts). A machine without the
 * program has nothing to say a call is on, so it counts as none, as does
 * an answer that can't tell or doesn't come in time. Why a program
 * can't be asked (missing, refusing or broken) is said once a process
 * for each reason, so such a machine shows rather than warming through
 * calls unseen; the first caller to meet a reason is the one told.
 */

import { askCall } from "../calls/probe.ts";

/** How long an answer may take before it counts as none. */
const ASK_TIMEOUT_MS = 3_000;

/** How often work held for a call looks again. */
export const CALL_LOOK_MS = 15_000;

/** The reasons this process has said a program can't be asked. */
const saidUnasked = new Set<string>();

/**
 * Whether a call is on now, as `program` says. `cannotAsk` hears, once a
 * process for each reason, why the program can't be asked.
 */
export async function callIsOn(
	options: {
		readonly program?: string;
		/** How long an answer may take, shorter only in a test. */
		readonly timeoutMs?: number;
		readonly cannotAsk?: (why: string) => void;
	} = {},
): Promise<boolean> {
	const { cannotAsk } = options;
	const onCall = await askCall({
		program: options.program,
		timeoutMs: options.timeoutMs ?? ASK_TIMEOUT_MS,
		cannotAsk:
			cannotAsk &&
			(({ why }) => {
				if (saidUnasked.has(why)) return;
				saidUnasked.add(why);
				cannotAsk(`${why}, so warms go whether or not a call is on`);
			}),
	});
	return onCall === true;
}
