/**
 * The agent fence by default: a session that names no sandbox is given
 * the fence where it can be had, so an agent's commands are fenced
 * unless the session says otherwise. It lives apart from sandbox.ts,
 * which says what each sandbox is, since this says which one a session
 * gets when it asks for none.
 */

import { FENCE } from "./fence.ts";
import { OFF, SANDBOX_VARIABLE } from "./sandbox.ts";
import { systemProgram } from "./system-program.ts";

/**
 * Ask for the agent fence where nothing asked for anything, so every
 * session's commands are fenced unless it says otherwise: on Linux,
 * with bubblewrap and landrun in the system's own profile, an unset
 * `PI_SANDBOX` is set to `fence`, in `env` itself, so every reader in
 * this process and every child it starts sees the one value. Answers
 * why it couldn't, on Linux without them, so that is said rather than
 * passed over; elsewhere there is no fence to ask for, and nothing is
 * said. A value already there, `off` or an empty one included, is left
 * as it is: `PI_SANDBOX=off` is the way back for one session. Until 13
 * November every session not started with the fence ran unfenced.
 */
export function fenceByDefault(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	find: (program: string) => string | undefined = systemProgram,
): string | undefined {
	if (env[SANDBOX_VARIABLE] !== undefined || platform !== "linux") {
		return undefined;
	}
	const missing = ["bwrap", "landrun"].filter((program) => !find(program));
	if (missing.length > 0) {
		return `The agent fence is off for this session: it needs bwrap and landrun in the system's own profile, and ${missing.join(" and ")} isn't there. Set ${SANDBOX_VARIABLE}=${OFF} to say that's meant.`;
	}
	env[SANDBOX_VARIABLE] = FENCE;
	return undefined;
}
