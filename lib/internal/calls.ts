/**
 * Whether a call is on, for work that would cut into one, such as a
 * cache warm that sends a whole conversation up the line. It asks
 * `a-call-is-on`, which exits 0 while a call is on, 1 while none is
 * and 2 when it can't tell. A machine without the program has nothing
 * to say a call is on, so it counts as none, as does an answer that
 * can't tell or doesn't come in time; the missing program is said
 * once, so such a machine shows rather than warming through calls
 * unseen.
 */

import { execFile } from "node:child_process";
import { isRecord } from "./record.ts";

/** The program that says whether a call is on. */
const CALL_PROGRAM = "a-call-is-on";

/** How long an answer may take before it counts as none. */
const ASK_TIMEOUT_MS = 3_000;

/** How often work held for a call looks again. */
export const CALL_LOOK_MS = 15_000;

/** Whether the missing program has been said, once for this module. */
let saidMissing = false;

/**
 * Whether a call is on now, as `program` says. `missing` hears, once,
 * that the program isn't there to ask.
 */
export function callIsOn(
	options: {
		readonly program?: string;
		readonly missing?: (why: string) => void;
	} = {},
): Promise<boolean> {
	const program = options.program ?? CALL_PROGRAM;
	return new Promise((resolve) => {
		execFile(program, [], { timeout: ASK_TIMEOUT_MS }, (error) => {
			if (isRecord(error) && error.code === "ENOENT" && !saidMissing) {
				saidMissing = true;
				options.missing?.(
					`${program} is not on the PATH, so warms go whether or not a call is on`,
				);
			}
			resolve(error === null);
		});
	});
}
