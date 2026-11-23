/**
 * Whether a call is on, for work that would cut into one, such as a
 * cache warm that sends a whole conversation up the line. It asks
 * `a-call-is-on` the shared way (calls/probe.ts). A machine without the
 * program has nothing to say a call is on, so it counts as none, as does
 * an answer that can't tell or doesn't come in time; a program that
 * can't be asked is said once a process, so such a machine shows rather
 * than warming through calls unseen.
 */

import { askCall } from "../calls/probe.ts";

/** How long an answer may take before it counts as none. */
const ASK_TIMEOUT_MS = 3_000;

/** How often work held for a call looks again. */
export const CALL_LOOK_MS = 15_000;

/** Whether this process has said the program can't be asked. */
let saidUnasked = false;

/**
 * Whether a call is on now, as `program` says. `missing` hears, once,
 * that the program can't be asked.
 */
export async function callIsOn(
	options: {
		readonly program?: string;
		readonly missing?: (why: string) => void;
	} = {},
): Promise<boolean> {
	const { missing } = options;
	const onCall = await askCall({
		program: options.program,
		timeoutMs: ASK_TIMEOUT_MS,
		cannotAsk:
			missing &&
			((trouble) => {
				if (saidUnasked) return;
				saidUnasked = true;
				missing(`${trouble.why}, so warms go whether or not a call is on`);
			}),
	});
	return onCall === true;
}
